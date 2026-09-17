#include "SpatialPrevisWorkspaceConformanceCommandlet.h"
#include "SpatialPrevisProjectCodec.h"
#include "SpatialPrevisProjectStore.h"
#include "SpatialPrevisWorkspaceCodec.h"
#include "SpatialPrevisWorkspaceRepository.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/FileManager.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"

namespace
{
using FObject = TSharedPtr<FJsonObject>;
using FValue = TSharedPtr<FJsonValue>;

bool Same(const FString& A, const FString& B)
{
    return A.Len() == B.Len() && (A.IsEmpty() || FMemory::Memcmp(*A, *B, A.Len() * sizeof(TCHAR)) == 0);
}

bool ReadObject(const FString& Json, FObject& Out, FString& Error)
{
    FValue Value;
    if (!FSpatialPrevisProjectCodec::ParseJson(Json, Value, Error)) return false;
    if (!Value.IsValid() || Value->Type != EJson::Object) { Error = TEXT("Expected an object payload"); return false; }
    Out = Value->AsObject();
    return true;
}

bool Strings(const FObject& Object, const TCHAR* Name, TArray<FString>& Out)
{
    const TArray<FValue>* Array = nullptr;
    if (!Object->TryGetArrayField(Name, Array)) return false;
    for (const FValue& Value : *Array)
    {
        if (!Value.IsValid() || Value->Type != EJson::String) return false;
        Out.Add(Value->AsString());
    }
    return true;
}

TArray<FValue> StringValues(const TArray<FString>& Values)
{
    TArray<FValue> Result;
    for (const FString& Value : Values) Result.Add(MakeShared<FJsonValueString>(Value));
    return Result;
}

FSpatialPrevisProjectStore::FAuthorizer FixtureAuthority()
{
    // Test host credentials are supplied outside transaction/imported JSON.
    // This is an executable policy fixture, not a production authentication provider.
    return [](const FSpatialPrevisPrincipal& Principal, const FString& Action, const TArray<FString>& Scope)
    {
        if (Same(Principal.Id, TEXT("denied"))) return false;
        if (Same(Principal.Id, TEXT("editor")) && !Same(Action, TEXT("edit"))) return false;
        if (Same(Principal.Id, TEXT("endpoint-denied")))
            for (const FString& Id : Scope) if (Same(Id, TEXT("inst_0002"))) return false;
        return true;
    };
}

FObject FindRecord(const FObject& Project, const FString& Id)
{
    const TArray<FValue>* Records = nullptr;
    if (!Project.IsValid() || !Project->TryGetArrayField(TEXT("records"), Records)) return nullptr;
    for (const FValue& Value : *Records)
    {
        if (Value.IsValid() && Value->Type == EJson::Object)
        {
            FString RecordId;
            if (Value->AsObject()->TryGetStringField(TEXT("id"), RecordId) && Same(RecordId, Id)) return Value->AsObject();
        }
    }
    return nullptr;
}

bool ExecuteStep(FSpatialPrevisProjectStore& Store, const FString& Action, const FObject& Input,
    const FSpatialPrevisPrincipal& Principal, FObject& OutResult, FString& Error)
{
    if (Same(Action, TEXT("execute"))) return Store.Execute(Input, Principal, OutResult, Error);
    if (Same(Action, TEXT("preview"))) return Store.Preview(Input, Principal, OutResult, Error);
    if (Same(Action, TEXT("preview-detached")))
    {
        FObject Preview;
        if (!Store.Preview(Input, Principal, Preview, Error)) return false;
        OutResult = FSpatialPrevisWorkspaceCodec::Clone(Preview);
        Input->SetArrayField(TEXT("operations"), {});
        const FObject* Project = nullptr;
        if (Preview->TryGetObjectField(TEXT("project"), Project)) (*Project)->SetArrayField(TEXT("records"), {});
        return true;
    }
    if (Same(Action, TEXT("cancel")) || Same(Action, TEXT("accept")))
    {
        FString Id;
        if (!Input->TryGetStringField(TEXT("previewId"), Id)) return false;
        if (Same(Action, TEXT("cancel"))) { Store.Cancel(Id); return true; }
        return Store.Accept(Id, Principal, OutResult, Error);
    }
    if (Same(Action, TEXT("undo")) || Same(Action, TEXT("redo")))
    {
        FString Key; double Revision = 0;
        if (!Input->TryGetStringField(TEXT("key"), Key) || !Input->TryGetNumberField(TEXT("baseRevision"), Revision)) return false;
        return Same(Action, TEXT("undo")) ? Store.Undo(Key, Revision, Principal, OutResult, Error)
            : Store.Redo(Key, Revision, Principal, OutResult, Error);
    }
    if (Same(Action, TEXT("reopen")) || Same(Action, TEXT("import")))
    {
        FString Json;
        if (Same(Action, TEXT("reopen")))
        {
            if (!FSpatialPrevisWorkspaceCodec::Serialize(Store.GetWorkspace(), Json, Error)) return false;
        }
        else if (!Input->TryGetStringField(TEXT("json"), Json)) return false;
        FObject Imported;
        if (!FSpatialPrevisWorkspaceRepository::Import(Json, Imported, Error)) return false;
        return Store.Initialize(Imported, FixtureAuthority(), Error);
    }
    if (Same(Action, TEXT("check")) || Same(Action, TEXT("technical-check")))
    {
        double Revision = 0;
        if (!Input->TryGetNumberField(TEXT("baseRevision"), Revision)) return false;
        FObject Proposal;
        if (Same(Action, TEXT("check")))
        {
            const FObject* Result = nullptr;
            if (!Input->TryGetObjectField(TEXT("result"), Result)) return false;
            Proposal = *Result;
        }
        else
        {
            FString RecordId, CheckId;
            if (!Input->TryGetStringField(TEXT("recordId"), RecordId) || !Input->TryGetStringField(TEXT("id"), CheckId)) return false;
            const FObject Project = Store.GetProject();
            const FObject Record = FindRecord(Project, RecordId);
            if (!Record.IsValid()) { Error = TEXT("Unknown technical-check record"); return false; }
            if (!FSpatialPrevisProjectStore::TechnicalDataCheck(Project, Record, CheckId, Proposal, Error)) return false;
        }
        return Store.RecordCheck(Proposal, Revision, OutResult, Error);
    }
    if (Same(Action, TEXT("review")))
    {
        FString CheckId, ReviewId, Now; TArray<FString> Evidence;
        if (!Input->TryGetStringField(TEXT("checkId"), CheckId) || !Input->TryGetStringField(TEXT("reviewId"), ReviewId)
            || !Input->TryGetStringField(TEXT("now"), Now) || !Strings(Input, TEXT("evidence"), Evidence)) return false;
        return Store.Review(CheckId, ReviewId, Evidence, Principal, OutResult, Error, Now);
    }
    if (Same(Action, TEXT("issue")))
    {
        FString Id, Now; TArray<FString> Required;
        if (!Input->TryGetStringField(TEXT("id"), Id) || !Input->TryGetStringField(TEXT("now"), Now)
            || !Strings(Input, TEXT("requiredCheckIds"), Required)) return false;
        return Store.Issue(Id, Required, Principal, OutResult, Error, Now);
    }
    if (Same(Action, TEXT("translate")) || Same(Action, TEXT("delete")))
    {
        FString Id, Key, Label; double Revision = 0; TArray<FValue> Operations;
        if (!Input->TryGetStringField(TEXT("instanceId"), Id) || !Input->TryGetStringField(TEXT("key"), Key)
            || !Input->TryGetStringField(TEXT("label"), Label) || !Input->TryGetNumberField(TEXT("baseRevision"), Revision)) return false;
        if (Same(Action, TEXT("translate")))
        {
            const TArray<FValue>* Position = nullptr;
            if (!Input->TryGetArrayField(TEXT("position"), Position) || Position->Num() != 3) return false;
            for (const FValue& Component : *Position) if (!Component.IsValid() || Component->Type != EJson::Number) return false;
            const FVector3d Metres((*Position)[0]->AsNumber(), (*Position)[1]->AsNumber(), (*Position)[2]->AsNumber());
            if (!FSpatialPrevisProjectStore::TranslateInstanceOperations(Store.GetProject(), Id, Metres, Operations, Error)) return false;
        }
        else if (!FSpatialPrevisProjectStore::DeleteInstanceOperations(Store.GetProject(), Id, Operations, Error)) return false;
        const FObject Transaction = MakeShared<FJsonObject>();
        Transaction->SetStringField(TEXT("key"), Key); Transaction->SetStringField(TEXT("label"), Label);
        Transaction->SetNumberField(TEXT("baseRevision"), Revision); Transaction->SetArrayField(TEXT("operations"), Operations);
        return Store.Execute(Transaction, Principal, OutResult, Error);
    }
    Error = FString::Printf(TEXT("Unknown workspace conformance action: %s"), *Action);
    return false;
}

using FIssuedBytes = TArray<TPair<FString, FString>>;
FIssuedBytes IssuedBytes(const FObject& Workspace)
{
    FIssuedBytes Result;
    const TArray<FValue>* Issued = nullptr;
    if (Workspace.IsValid() && Workspace->TryGetArrayField(TEXT("issued"), Issued))
        for (const FValue& Value : *Issued)
            if (Value.IsValid() && Value->Type == EJson::Object)
            {
                FString Id, Content;
                if (Value->AsObject()->TryGetStringField(TEXT("id"), Id) && Value->AsObject()->TryGetStringField(TEXT("content"), Content))
                    Result.Emplace(Id, Content);
            }
    return Result;
}

bool PreserveIssued(FIssuedBytes& Baseline, const FObject& Workspace, bool bAllowNewIssue)
{
    const FIssuedBytes Current = IssuedBytes(Workspace);
    for (const auto& Previous : Baseline)
    {
        const auto* Match = Current.FindByPredicate([&](const auto& Value) { return Same(Value.Key, Previous.Key); });
        if (!Match || !Same(Match->Value, Previous.Value)) return false;
    }
    for (const auto& Value : Current)
        if (!Baseline.ContainsByPredicate([&](const auto& Previous) { return Same(Value.Key, Previous.Key); }))
        {
            if (!bAllowNewIssue) return false;
            Baseline.Add(Value);
        }
    return true;
}
}

USpatialPrevisWorkspaceConformanceCommandlet::USpatialPrevisWorkspaceConformanceCommandlet()
{
    IsClient = false; IsServer = false; IsEditor = true; LogToConsole = true;
}

int32 USpatialPrevisWorkspaceConformanceCommandlet::Main(const FString& Params)
{
    FString CorpusPath, ReportPath;
    if (!FParse::Value(*Params, TEXT("Corpus="), CorpusPath) || !FParse::Value(*Params, TEXT("Report="), ReportPath)
        || IFileManager::Get().FileExists(*ReportPath))
    { UE_LOG(LogTemp, Error, TEXT("Requires -Corpus=<workspace corpus> -Report=<new report path>")); return 2; }
    FString Text, Error; FObject Corpus;
    if (!FFileHelper::LoadFileToString(Text, *CorpusPath) || !ReadObject(Text, Corpus, Error)) return 2;
    FString Format, Authorization; double Version = 0;
    const TArray<FValue>* ParseCases = nullptr; const TArray<FValue>* HashCases = nullptr; const TArray<FValue>* Scenarios = nullptr;
    if (!Corpus->TryGetStringField(TEXT("format"), Format) || !Same(Format, TEXT("spatial-previs-workspace-conformance"))
        || !Corpus->TryGetNumberField(TEXT("version"), Version) || Version != 1
        || !Corpus->TryGetStringField(TEXT("authorization"), Authorization) || !Same(Authorization, TEXT("fixture-principals-v1"))
        || !Corpus->TryGetArrayField(TEXT("parseCases"), ParseCases) || ParseCases->IsEmpty()
        || !Corpus->TryGetArrayField(TEXT("hashCases"), HashCases) || HashCases->IsEmpty()
        || !Corpus->TryGetArrayField(TEXT("scenarios"), Scenarios) || Scenarios->IsEmpty()) return 2;

    int32 Failures = 0; TArray<FString> Seen;
    auto NewId = [&](const FObject& Object, FString& Id)
    {
        if (!Object.IsValid() || !Object->TryGetStringField(TEXT("id"), Id) || Id.IsEmpty()
            || Seen.ContainsByPredicate([&](const FString& Prior) { return Same(Id, Prior); })) return false;
        Seen.Add(Id); return true;
    };
    TArray<FValue> ParseResults, HashResults, ScenarioResults;
    for (const FValue& Value : *ParseCases)
    {
        if (!Value.IsValid() || Value->Type != EJson::Object) return 2;
        const FObject Test = Value->AsObject(); FString Id, Json; bool Expected = false;
        if (!NewId(Test, Id) || !Test->TryGetStringField(TEXT("json"), Json) || !Test->TryGetBoolField(TEXT("valid"), Expected)) return 2;
        Error.Reset(); FObject Workspace = MakeShared<FJsonObject>(); Workspace->SetStringField(TEXT("sentinel"), TEXT("unchanged"));
        const FObject Prior = Workspace;
        const bool Accepted = FSpatialPrevisWorkspaceCodec::Parse(Json, Workspace, Error);
        bool Passed = Accepted == Expected && (Accepted || Workspace == Prior);
        const FObject Result = MakeShared<FJsonObject>(); Result->SetStringField(TEXT("id"), Id);
        Result->SetBoolField(TEXT("accepted"), Accepted); Result->SetBoolField(TEXT("unchangedOnRejection"), Accepted || Workspace == Prior);
        if (Accepted)
        {
            FString Export; FObject Reopened;
            const bool Serialized = FSpatialPrevisWorkspaceCodec::Serialize(Workspace, Export, Error);
            Passed &= Serialized && FSpatialPrevisWorkspaceCodec::Parse(Export, Reopened, Error);
            if (Serialized) Result->SetStringField(TEXT("workspaceJson"), Export);
        }
        Result->SetBoolField(TEXT("passed"), Passed); Result->SetStringField(TEXT("error"), Error);
        ParseResults.Add(MakeShared<FJsonValueObject>(Result));
        if (!Passed) { ++Failures; UE_LOG(LogTemp, Error, TEXT("Workspace parse failed: %s: %s"), *Id, *Error); }
    }
    for (const FValue& Value : *HashCases)
    {
        if (!Value.IsValid() || Value->Type != EJson::Object) return 2;
        const FObject Test = Value->AsObject(); FString Id, Json, Model, ModelVersion, ExpectedHash, ExpectedCanonical; TArray<FString> Scope;
        if (!NewId(Test, Id) || !Test->TryGetStringField(TEXT("projectJson"), Json) || !Strings(Test, TEXT("scope"), Scope)
            || !Test->TryGetStringField(TEXT("model"), Model) || !Test->TryGetStringField(TEXT("modelVersion"), ModelVersion)
            || !Test->TryGetStringField(TEXT("expectedHash"), ExpectedHash) || !Test->TryGetStringField(TEXT("expectedCanonical"), ExpectedCanonical)) return 2;
        Error.Reset(); FObject Project; FString Hash, Canonical;
        const bool Accepted = FSpatialPrevisProjectCodec::Parse(Json, Project, Error)
            && FSpatialPrevisWorkspaceCodec::InputHash(Project, Scope, Model, ModelVersion, Hash, Error);
        if (Accepted)
        {
            const FObject Payload = MakeShared<FJsonObject>();
            Payload->SetStringField(TEXT("projectId"), Project->GetStringField(TEXT("projectId")));
            Payload->SetStringField(TEXT("coordinateFrame"), Project->GetStringField(TEXT("coordinateFrame")));
            Scope.Sort([](const FString& A, const FString& B) { return A.Compare(B, ESearchCase::CaseSensitive) < 0; });
            Payload->SetArrayField(TEXT("scope"), StringValues(Scope));
            Payload->SetStringField(TEXT("model"), Model); Payload->SetStringField(TEXT("modelVersion"), ModelVersion);
            Payload->SetArrayField(TEXT("records"), FSpatialPrevisWorkspaceCodec::ScopedInputs(Project, Scope));
            Canonical = FSpatialPrevisWorkspaceCodec::Canonical(MakeShared<FJsonValueObject>(Payload));
        }
        const bool Passed = Accepted && Same(Hash, ExpectedHash) && Same(Canonical, ExpectedCanonical);
        const FObject Result = MakeShared<FJsonObject>(); Result->SetStringField(TEXT("id"), Id);
        Result->SetBoolField(TEXT("accepted"), Accepted); Result->SetBoolField(TEXT("passed"), Passed);
        Result->SetStringField(TEXT("hash"), Hash); Result->SetStringField(TEXT("canonical"), Canonical); Result->SetStringField(TEXT("error"), Error);
        HashResults.Add(MakeShared<FJsonValueObject>(Result));
        if (!Passed) { ++Failures; UE_LOG(LogTemp, Error, TEXT("Workspace hash failed: %s: %s"), *Id, *Error); }
    }
    for (const FValue& Value : *Scenarios)
    {
        if (!Value.IsValid() || Value->Type != EJson::Object) return 2;
        const FObject Scenario = Value->AsObject(); FString Id, InitialJson; const TArray<FValue>* Steps = nullptr;
        if (!NewId(Scenario, Id) || !Scenario->TryGetStringField(TEXT("initialJson"), InitialJson)
            || !Scenario->TryGetArrayField(TEXT("steps"), Steps) || Steps->IsEmpty()) return 2;
        Error.Reset(); FObject Initial; FSpatialPrevisProjectStore Store;
        const bool Initialized = FSpatialPrevisWorkspaceCodec::Parse(InitialJson, Initial, Error)
            && Store.Initialize(Initial, FixtureAuthority(), Error);
        const FObject ScenarioResult = MakeShared<FJsonObject>(); ScenarioResult->SetStringField(TEXT("id"), Id);
        ScenarioResult->SetBoolField(TEXT("initialized"), Initialized);
        TArray<FValue> StepResults; FIssuedBytes Baseline = IssuedBytes(Initial);
        if (!Initialized) { ++Failures; ScenarioResult->SetStringField(TEXT("error"), Error); }
        else for (const FValue& StepValue : *Steps)
        {
            if (!StepValue.IsValid() || StepValue->Type != EJson::Object) return 2;
            const FObject Step = StepValue->AsObject(); FString StepId, Action, Json, PrincipalId, PrincipalKind;
            bool Expected = false; const FObject* PrincipalObject = nullptr; FObject Input;
            if (!NewId(Step, StepId) || !Step->TryGetStringField(TEXT("action"), Action) || !Step->TryGetStringField(TEXT("json"), Json)
                || !Step->TryGetBoolField(TEXT("expectedAccepted"), Expected) || !Step->TryGetObjectField(TEXT("principal"), PrincipalObject)
                || !(*PrincipalObject)->TryGetStringField(TEXT("id"), PrincipalId) || !(*PrincipalObject)->TryGetStringField(TEXT("kind"), PrincipalKind)
                || (!Same(PrincipalKind, TEXT("human")) && !Same(PrincipalKind, TEXT("automation"))) || !ReadObject(Json, Input, Error)) return 2;
            const FSpatialPrevisPrincipal Principal{PrincipalId, Same(PrincipalKind, TEXT("human"))};
            FString Before, StateJson, ResultJson = TEXT("null"); FObject ResultObject;
            Error.Reset();
            if (!FSpatialPrevisWorkspaceCodec::Serialize(Store.GetWorkspace(), Before, Error)) return 2;
            const bool Accepted = ExecuteStep(Store, Action, Input, Principal, ResultObject, Error);
            const FString ActionError = Error; Error.Reset();
            const bool Serialized = FSpatialPrevisWorkspaceCodec::Serialize(Store.GetWorkspace(), StateJson, Error);
            const bool OutputSerialized = !ResultObject.IsValid()
                || FSpatialPrevisProjectCodec::SerializeJson(MakeShared<FJsonValueObject>(ResultObject), ResultJson, Error);
            const bool Unchanged = Accepted || Same(Before, StateJson);
            if (Accepted && Same(Action, TEXT("import")))
            {
                FString ImportedJson; FObject ImportedBaseline;
                if (!Input->TryGetStringField(TEXT("json"), ImportedJson)
                    || !FSpatialPrevisWorkspaceCodec::Parse(ImportedJson, ImportedBaseline, Error)) return 2;
                Baseline = IssuedBytes(ImportedBaseline);
            }
            // Fresh native issue formatting may differ from JS. It becomes immutable
            // immediately; imported content always uses the source bytes as baseline.
            const bool Preserved = PreserveIssued(Baseline, Store.GetWorkspace(), Accepted && Same(Action, TEXT("issue")));
            const bool Passed = Accepted == Expected && Serialized && OutputSerialized && Unchanged && Preserved;
            const FObject Result = MakeShared<FJsonObject>(); Result->SetStringField(TEXT("id"), StepId);
            Result->SetBoolField(TEXT("accepted"), Accepted); Result->SetBoolField(TEXT("passed"), Passed);
            Result->SetBoolField(TEXT("unchangedOnRejection"), Unchanged); Result->SetBoolField(TEXT("issuedBytesPreserved"), Preserved);
            Result->SetStringField(TEXT("stateJson"), StateJson); Result->SetStringField(TEXT("resultJson"), ResultJson);
            Result->SetStringField(TEXT("error"), ActionError.IsEmpty() ? Error : ActionError);
            StepResults.Add(MakeShared<FJsonValueObject>(Result));
            if (!Passed) { ++Failures; UE_LOG(LogTemp, Error, TEXT("Workspace step failed: %s: %s"), *StepId, *ActionError); }
        }
        ScenarioResult->SetArrayField(TEXT("steps"), StepResults); ScenarioResults.Add(MakeShared<FJsonValueObject>(ScenarioResult));
    }
    const FObject Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("format"), TEXT("spatial-previs-native-workspace-conformance")); Report->SetNumberField(TEXT("version"), 1);
    Report->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
    Report->SetStringField(TEXT("scope"), TEXT("Workspace codec, hashes, commands, history, import trust, checks and issued-byte preservation"));
    Report->SetNumberField(TEXT("failures"), Failures); Report->SetArrayField(TEXT("parseCases"), ParseResults);
    Report->SetArrayField(TEXT("hashCases"), HashResults); Report->SetArrayField(TEXT("scenarios"), ScenarioResults);
    FString ReportJson;
    if (!FSpatialPrevisProjectCodec::SerializeJson(MakeShared<FJsonValueObject>(Report), ReportJson, Error)) return 2;
    IFileManager::Get().MakeDirectory(*FPaths::GetPath(ReportPath), true);
    if (!FFileHelper::SaveStringToFile(ReportJson, *ReportPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) return 2;
    UE_LOG(LogTemp, Display, TEXT("Workspace corpus executed; failures: %d. Compare report outputs against the TypeScript corpus."), Failures);
    return Failures == 0 ? 0 : 1;
}
