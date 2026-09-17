#include "SpatialPrevisProjectStore.h"

#include "SpatialPrevisProjectCodec.h"
#include "SpatialPrevisWorkspaceCodec.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/DateTime.h"
#include "Misc/Crc.h"

namespace SpatialPrevisStore
{
using FValue = TSharedPtr<FJsonValue>;
using FObject = TSharedPtr<FJsonObject>;
using FValues = TArray<FValue>;
using FCodec = FSpatialPrevisWorkspaceCodec;

bool Fail(FString& Error, const FString& Message) { Error = Message; return false; }
bool Same(const FString& A, const FString& B)
{
    return A.Len() == B.Len() && (A.IsEmpty() || FMemory::Memcmp(*A, *B, A.Len() * sizeof(TCHAR)) == 0);
}
struct FExactString
{
    FString Text;
    FExactString() = default;
    FExactString(const FString& InText) : Text(InText) {}
    bool operator==(const FExactString& Other) const { return Same(Text, Other.Text); }
    friend uint32 GetTypeHash(const FExactString& Key) { return FCrc::MemCrc32(*Key.Text, Key.Text.Len() * sizeof(TCHAR)); }
};
bool Has(const TArray<FString>& Strings, const FString& Target)
{
    return Strings.ContainsByPredicate([&Target](const FString& String) { return Same(String, Target); });
}
void AddUnique(TArray<FString>& Strings, const FString& String) { if (!Has(Strings, String)) Strings.Add(String); }
bool Nonempty(const FString& String)
{
    for (int32 Index = 0; Index < String.Len(); ++Index)
    {
        const uint32 C = static_cast<uint32>(String[Index]);
        if (!((C >= 0x09 && C <= 0x0d) || C == 0x20 || C == 0xa0 || C == 0x1680 ||
            (C >= 0x2000 && C <= 0x200a) || C == 0x2028 || C == 0x2029 || C == 0x202f || C == 0x205f || C == 0x3000 || C == 0xfeff)) return true;
    }
    return false;
}
FValue Field(const FObject& Object, const TCHAR* Key)
{
    if (!Object.IsValid()) return nullptr;
    for (const auto& Entry : Object->Values)
        if (Same(FString(Entry.Key.Len(), *Entry.Key), FString(Key))) return Entry.Value;
    return nullptr;
}
FString Str(const FObject& Object, const TCHAR* Key)
{
    const FValue Result = Field(Object, Key);
    return Result.IsValid() && Result->Type == EJson::String ? Result->AsString() : FString();
}
bool ReadBool(const FObject& Object, const TCHAR* Key, bool& OutBool)
{
    const FValue Result = Field(Object, Key);
    if (!Result.IsValid() || Result->Type != EJson::Boolean) return false;
    OutBool = Result->AsBool();
    return true;
}
bool Bool(const FObject& Object, const TCHAR* Key)
{
    bool Result = false;
    ReadBool(Object, Key, Result);
    return Result;
}
bool ReadNumber(const FObject& Object, const TCHAR* Key, double& Number)
{
    const FValue Result = Field(Object, Key);
    if (!Result.IsValid() || Result->Type != EJson::Number) return false;
    Number = Result->AsNumber();
    return true;
}
FObject Obj(const FObject& Object, const TCHAR* Key)
{
    const FValue Result = Field(Object, Key);
    return Result.IsValid() && Result->Type == EJson::Object ? Result->AsObject() : nullptr;
}
FValues Arr(const FObject& Object, const TCHAR* Key)
{
    const FValue Result = Field(Object, Key);
    return Result.IsValid() && Result->Type == EJson::Array ? Result->AsArray() : FValues();
}
FObject AsObj(const FValue& Value)
{
    return Value.IsValid() && Value->Type == EJson::Object ? Value->AsObject() : nullptr;
}
FValue Value(const FObject& Object) { return MakeShared<FJsonValueObject>(Object); }
FValue Value(const FString& String) { return MakeShared<FJsonValueString>(String); }
FValues Values(const TArray<FString>& Strings)
{
    FValues Result;
    for (const FString& String : Strings) Result.Add(Value(String));
    return Result;
}
bool Strings(const FObject& Object, const TCHAR* Key, TArray<FString>& Result)
{
    const FValue Array = Field(Object, Key);
    if (!Array.IsValid() || Array->Type != EJson::Array) return false;
    Result.Reset();
    for (const FValue& Item : Array->AsArray())
    {
        FString String;
        if (!Item.IsValid() || !Item->TryGetString(String)) return false;
        Result.Add(String);
    }
    return true;
}
TArray<FString> Strings(const FObject& Object, const TCHAR* Key)
{
    TArray<FString> Result;
    Strings(Object, Key, Result);
    return Result;
}
FString Canon(const FValues& Array) { return FCodec::Canonical(MakeShared<FJsonValueArray>(Array)); }
FObject Find(const FValues& Records, const FString& Id)
{
    for (const FValue& Record : Records)
    {
        const FObject Object = AsObj(Record);
        if (Same(Str(Object, TEXT("id")), Id)) return Object;
    }
    return nullptr;
}
double Revision(const FObject& Project)
{
    double Result = -1;
    ReadNumber(Project, TEXT("revision"), Result);
    return Result;
}
TArray<FString> ChangedIds(const FValues& Before, const FValues& After)
{
    TArray<FString> Order;
    TMap<FExactString, FString> Old, Next;
    for (const FValue& Record : Before)
    {
        const FString Id = Str(AsObj(Record), TEXT("id"));
        Order.Add(Id);
        Old.Add(Id, FCodec::Canonical(Record));
    }
    for (const FValue& Record : After)
    {
        const FString Id = Str(AsObj(Record), TEXT("id"));
        if (!Old.Contains(Id)) Order.Add(Id);
        Next.Add(Id, FCodec::Canonical(Record));
    }
    TArray<FString> Changed;
    for (const FString& Id : Order)
    {
        const FString* A = Old.Find(Id);
        const FString* B = Next.Find(Id);
        if (!A || !B || !Same(*A, *B)) Changed.Add(Id);
    }
    return Changed;
}
FObject RemoveOperation(const FString& Id)
{
    const FObject Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("type"), TEXT("remove"));
    Result->SetStringField(TEXT("id"), Id);
    return Result;
}
FObject PutOperation(const FObject& Record)
{
    const FObject Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("type"), TEXT("put"));
    Result->SetObjectField(TEXT("record"), Record);
    return Result;
}
}

using namespace SpatialPrevisStore;

bool FSpatialPrevisProjectStore::Initialize(const FObject& WorkspaceOrProject, FAuthorizer Authorizer, FString& OutError)
{
    FObject Candidate;
    if (!WorkspaceOrProject.IsValid()) return Fail(OutError, TEXT("Workspace is required"));
    if (Field(WorkspaceOrProject, TEXT("format")).IsValid()) Candidate = FCodec::Clone(WorkspaceOrProject);
    else if (!FCodec::FromProject(WorkspaceOrProject, Candidate, OutError)) return false;
    if (!FCodec::Validate(Candidate, OutError)) return false;
    State = Candidate;
    Authorize = MoveTemp(Authorizer);
    Previews.Reset();
    PreviewCounter = 0;
    OutError.Reset();
    return true;
}

FObject FSpatialPrevisProjectStore::GetWorkspace() const { return FCodec::Clone(State); }
FObject FSpatialPrevisProjectStore::GetProject() const { return FCodec::Clone(Obj(State, TEXT("project"))); }

bool FSpatialPrevisProjectStore::Permit(const FSpatialPrevisPrincipal& Principal, const FString& Action,
    const TArray<FString>& Scope, FString& OutError) const
{
    if (!Nonempty(Principal.Id) || !Authorize || !Authorize(Principal, Action, Scope))
        return Fail(OutError, TEXT("Not authorized to ") + Action);
    if (!Same(Action, TEXT("edit")) && !Principal.bHuman) return Fail(OutError, TEXT("Human authority required to ") + Action);
    return true;
}

bool FSpatialPrevisProjectStore::Request(const FObject& Transaction, FString& OutError) const
{
    if (!State.IsValid()) return Fail(OutError, TEXT("Workspace is not initialized"));
    if (!Transaction.IsValid() || !Nonempty(Str(Transaction, TEXT("key")))
        || !Nonempty(Str(Transaction, TEXT("label"))) || Arr(Transaction, TEXT("operations")).IsEmpty())
        return Fail(OutError, TEXT("Transaction requires a key, label and operations"));
    if (Has(Strings(State, TEXT("acceptedKeys")), Str(Transaction, TEXT("key"))))
        return Fail(OutError, TEXT("Duplicate idempotency key"));
    double BaseRevision = -1;
    if (!ReadNumber(Transaction, TEXT("baseRevision"), BaseRevision)
        || BaseRevision != Revision(Obj(State, TEXT("project"))))
        return Fail(OutError, TEXT("Stale base revision; reopen the proposal"));
    return true;
}

bool FSpatialPrevisProjectStore::Stage(const FObject& Transaction, const FSpatialPrevisPrincipal& Principal,
    FObject& OutProject, FString& OutError) const
{
    if (!Request(Transaction, OutError)) return false;
    const FObject Before = Obj(State, TEXT("project"));
    const FObject Next = FCodec::Clone(Before);
    FValues Records = Arr(Next, TEXT("records"));
    TSet<FExactString> Touched;
    for (const FValue& Item : Arr(Transaction, TEXT("operations")))
    {
        const FObject Operation = AsObj(Item);
        const FString Type = Str(Operation, TEXT("type"));
        if (!Operation.IsValid() || (!Same(Type, TEXT("put")) && !Same(Type, TEXT("remove")) && !Same(Type, TEXT("lock"))))
            return Fail(OutError, TEXT("Unsupported operation"));
        const FObject Incoming = Obj(Operation, TEXT("record"));
        const FString Id = Same(Type, TEXT("put")) ? Str(Incoming, TEXT("id")) : Str(Operation, TEXT("id"));
        if (Id.IsEmpty() || Touched.Contains(Id)) return Fail(OutError, TEXT("Each record may be targeted once per transaction"));
        Touched.Add(Id);
        const FObject Old = Find(Records, Id);
        if (!Permit(Principal, TEXT("edit"), {Id}, OutError)) return false;
        if (Same(Str(Old, TEXT("kind")), TEXT("document_snapshot")) && Same(Str(Old, TEXT("status")), TEXT("issued")))
            return Fail(OutError, TEXT("Issued snapshots are immutable"));
        if (Same(Type, TEXT("lock")))
        {
            bool Locked = false;
            if (!Old.IsValid() || !ReadBool(Operation, TEXT("locked"), Locked)) return Fail(OutError, TEXT("Invalid lock target"));
            if (!Permit(Principal, TEXT("unlock"), {Id}, OutError)) return false;
            Old->SetBoolField(TEXT("locked"), Locked);
        }
        else
        {
            if (Bool(Old, TEXT("locked"))) return Fail(OutError, TEXT("Locked record: ") + Id);
            if (Same(Type, TEXT("remove")))
            {
                if (!Old.IsValid()) return Fail(OutError, TEXT("Missing record: ") + Id);
                Records.RemoveAll([&Id](const FValue& Record) { return Same(Str(AsObj(Record), TEXT("id")), Id); });
            }
            else
            {
                bool IncomingLocked = false;
                const bool HasLocked = Incoming.IsValid() && ReadBool(Incoming, TEXT("locked"), IncomingLocked);
                if (Old.IsValid() && (!Same(Str(Old, TEXT("kind")), Str(Incoming, TEXT("kind")))
                    || !HasLocked || Bool(Old, TEXT("locked")) != IncomingLocked))
                    return Fail(OutError, TEXT("Kind/lock changes need an explicit operation"));
                if (!Old.IsValid() && IncomingLocked) return Fail(OutError, TEXT("Create an unlocked record, then lock it explicitly"));
                if (Same(Str(Incoming, TEXT("kind")), TEXT("document_snapshot")) && Same(Str(Incoming, TEXT("status")), TEXT("issued")))
                    return Fail(OutError, TEXT("Use the authorized issuance path"));
                const FValue Replacement = Value(FCodec::Clone(Incoming));
                if (Old.IsValid())
                {
                    for (FValue& Record : Records) if (Same(Str(AsObj(Record), TEXT("id")), Id)) { Record = Replacement; break; }
                }
                else Records.Add(Replacement);
            }
        }
    }
    Next->SetArrayField(TEXT("records"), Records);
    if (!FSpatialPrevisProjectCodec::Validate(Next, OutError)) return false;
    const FValues BeforeRecords = Arr(Before, TEXT("records"));
    for (const FString& Id : ChangedIds(BeforeRecords, Records))
    {
        const FObject Old = Find(BeforeRecords, Id), Current = Find(Records, Id);
        for (const FObject& Record : {Old, Current})
        {
            if (!Record.IsValid()) continue;
            const FString Kind = Str(Record, TEXT("kind"));
            TArray<FString> Affected;
            if (Same(Kind, TEXT("connection")) || Same(Kind, TEXT("mechanical_attachment")) || Same(Kind, TEXT("assembly")))
                Affected = FCodec::References(Record);
            if (Same(Kind, TEXT("port"))) Affected = {Str(Record, TEXT("instanceId"))};
            if (Same(Kind, TEXT("asset_instance")) && (!Same(Str(Old, TEXT("kind")), TEXT("asset_instance"))
                || !Same(Str(Current, TEXT("kind")), TEXT("asset_instance"))
                || !Same(Str(Old, TEXT("inventoryItemId")), Str(Current, TEXT("inventoryItemId")))))
            {
                const FString Allocation = Str(Record, TEXT("inventoryItemId"));
                if (!Allocation.IsEmpty()) Affected = {Allocation};
            }
            for (const FString& Endpoint : Affected)
            {
                if (!Permit(Principal, TEXT("edit"), {Endpoint}, OutError)) return false;
                const FObject PriorEndpoint = Find(BeforeRecords, Endpoint);
                if (Bool(PriorEndpoint, TEXT("locked"))) return Fail(OutError, TEXT("Locked relationship endpoint: ") + Endpoint);
                if (Same(Str(PriorEndpoint, TEXT("kind")), TEXT("port")))
                {
                    const FString InstanceId = Str(PriorEndpoint, TEXT("instanceId"));
                    if (!Permit(Principal, TEXT("edit"), {InstanceId}, OutError)) return false;
                    if (Bool(Find(BeforeRecords, InstanceId), TEXT("locked"))) return Fail(OutError, TEXT("Locked instance: ") + InstanceId);
                }
            }
        }
    }
    OutProject = Next;
    OutError.Reset();
    return true;
}

bool FSpatialPrevisProjectStore::Preview(const FObject& Transaction, const FSpatialPrevisPrincipal& Principal,
    FObject& OutPreview, FString& OutError)
{
    FObject Project;
    if (!Stage(Transaction, Principal, Project, OutError)) return false;
    const FString Id = FString::Printf(TEXT("preview:%llu"), static_cast<unsigned long long>(++PreviewCounter));
    Previews.Add(Id, FCodec::Clone(Transaction));
    const FObject Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("id"), Id);
    Result->SetNumberField(TEXT("baseRevision"), Revision(Obj(State, TEXT("project"))));
    Result->SetObjectField(TEXT("project"), Project);
    Result->SetArrayField(TEXT("changedIds"), Values(ChangedIds(Arr(Obj(State, TEXT("project")), TEXT("records")), Arr(Project, TEXT("records")))));
    OutPreview = Result;
    OutError.Reset();
    return true;
}

void FSpatialPrevisProjectStore::Cancel(const FString& PreviewId)
{
    for (auto It = Previews.CreateIterator(); It; ++It)
        if (Same(It.Key(), PreviewId)) { It.RemoveCurrent(); break; }
}

bool FSpatialPrevisProjectStore::Accept(const FString& PreviewId, const FSpatialPrevisPrincipal& Principal,
    FObject& OutChange, FString& OutError)
{
    if (!Principal.bHuman) return Fail(OutError, TEXT("A human must accept a preview"));
    const FObject* Transaction = nullptr;
    for (const auto& Pair : Previews) if (Same(Pair.Key, PreviewId)) { Transaction = &Pair.Value; break; }
    if (!Transaction) return Fail(OutError, TEXT("Preview is missing or canceled"));
    if (!Apply(*Transaction, Principal, OutChange, OutError)) return false;
    Cancel(PreviewId);
    return true;
}

bool FSpatialPrevisProjectStore::Execute(const FObject& Transaction, const FSpatialPrevisPrincipal& Principal,
    FObject& OutChange, FString& OutError)
{
    if (!Principal.bHuman) return Fail(OutError, TEXT("Automatic proposals require preview and human acceptance"));
    return Apply(Transaction, Principal, OutChange, OutError);
}

bool FSpatialPrevisProjectStore::Apply(const FObject& Transaction, const FSpatialPrevisPrincipal& Principal,
    FObject& OutChange, FString& OutError)
{
    FObject Project;
    if (!Stage(Transaction, Principal, Project, OutError)) return false;
    const FValues Before = Arr(Obj(State, TEXT("project")), TEXT("records"));
    const FValues After = Arr(Project, TEXT("records"));
    if (ChangedIds(Before, After).IsEmpty()) return Fail(OutError, TEXT("Transaction has no changes"));
    const FObject Candidate = GetWorkspace();
    const FObject Entry = MakeShared<FJsonObject>();
    Entry->SetStringField(TEXT("key"), Str(Transaction, TEXT("key")));
    Entry->SetStringField(TEXT("label"), Str(Transaction, TEXT("label")));
    Entry->SetArrayField(TEXT("before"), Arr(Obj(Candidate, TEXT("project")), TEXT("records")));
    Entry->SetArrayField(TEXT("after"), After);
    FValues Keys = Arr(Candidate, TEXT("acceptedKeys")); Keys.Add(Value(Str(Transaction, TEXT("key"))));
    FValues UndoEntries = Arr(Candidate, TEXT("undo")); UndoEntries.Add(Value(Entry));
    Candidate->SetArrayField(TEXT("acceptedKeys"), Keys);
    Candidate->SetArrayField(TEXT("undo"), UndoEntries);
    Candidate->SetArrayField(TEXT("redo"), {});
    return Commit(Candidate, After, Str(Transaction, TEXT("label")), OutChange, OutError);
}

bool FSpatialPrevisProjectStore::Undo(const FString& Key, double BaseRevision, const FSpatialPrevisPrincipal& Principal,
    FObject& OutChange, FString& OutError) { return Travel(TEXT("undo"), Key, BaseRevision, Principal, OutChange, OutError); }
bool FSpatialPrevisProjectStore::Redo(const FString& Key, double BaseRevision, const FSpatialPrevisPrincipal& Principal,
    FObject& OutChange, FString& OutError) { return Travel(TEXT("redo"), Key, BaseRevision, Principal, OutChange, OutError); }

bool FSpatialPrevisProjectStore::Travel(const FString& Direction, const FString& Key, double BaseRevision,
    const FSpatialPrevisPrincipal& Principal, FObject& OutChange, FString& OutError)
{
    const FObject Transaction = MakeShared<FJsonObject>();
    Transaction->SetStringField(TEXT("key"), Key);
    Transaction->SetStringField(TEXT("label"), Direction);
    Transaction->SetNumberField(TEXT("baseRevision"), BaseRevision);
    Transaction->SetArrayField(TEXT("operations"), {Value(RemoveOperation(TEXT("history")))});
    if (!Request(Transaction, OutError)) return false;
    if (!Principal.bHuman) return Fail(OutError, TEXT("Human action required for history"));
    const FObject Candidate = GetWorkspace();
    FValues Entries = Arr(Candidate, *Direction);
    if (Entries.IsEmpty()) return Fail(OutError, TEXT("Nothing to ") + Direction);
    const FObject Entry = AsObj(Entries.Pop(EAllowShrinking::No));
    const bool bUndo = Same(Direction, TEXT("undo"));
    const FValues Current = Arr(Obj(Candidate, TEXT("project")), TEXT("records"));
    const FValues Expected = Arr(Entry, bUndo ? TEXT("after") : TEXT("before"));
    if (!Same(Canon(Expected), Canon(Current))) return Fail(OutError, TEXT("History conflicts with current state"));
    const FValues Target = Arr(Entry, bUndo ? TEXT("before") : TEXT("after"));
    const TArray<FString> Ids = ChangedIds(Current, Target);
    if (!Permit(Principal, TEXT("edit"), Ids, OutError)) return false;
    bool bLocked = false;
    for (const FString& Id : Ids) if (Bool(Find(Current, Id), TEXT("locked"))) bLocked = true;
    if (bLocked && !Permit(Principal, TEXT("unlock"), Ids, OutError)) return false;
    const TCHAR* OtherDirection = bUndo ? TEXT("redo") : TEXT("undo");
    FValues OtherEntries = Arr(Candidate, OtherDirection); OtherEntries.Add(Value(Entry));
    FValues Keys = Arr(Candidate, TEXT("acceptedKeys")); Keys.Add(Value(Key));
    Candidate->SetArrayField(*Direction, Entries);
    Candidate->SetArrayField(OtherDirection, OtherEntries);
    Candidate->SetArrayField(TEXT("acceptedKeys"), Keys);
    return Commit(Candidate, Target, Direction + TEXT(": ") + Str(Entry, TEXT("label")), OutChange, OutError);
}

bool FSpatialPrevisProjectStore::Commit(const FObject& CandidateState, const FValues& Records,
    const FString& Label, FObject& OutChange, FString& OutError)
{
    const FObject Before = Obj(State, TEXT("project"));
    const FObject Next = FCodec::Clone(Before);
    Next->SetArrayField(TEXT("records"), Records);
    Next->SetNumberField(TEXT("revision"), Revision(Before) + 1);
    if (!FSpatialPrevisProjectCodec::Validate(Next, OutError)) return false;
    // Candidate state and records belong exclusively to this staged transaction.
    for (const FValue& Item : Arr(CandidateState, TEXT("checks")))
    {
        const FObject Check = AsObj(Item);
        const TArray<FString> Scope = Strings(Check, TEXT("scope"));
        if (!Same(Canon(FCodec::ScopedInputs(Before, Scope)), Canon(FCodec::ScopedInputs(Next, Scope))))
            Check->SetStringField(TEXT("status"), TEXT("stale"));
    }
    for (const FValue& Item : Arr(CandidateState, TEXT("reviews")))
    {
        const FObject ReviewRecord = AsObj(Item);
        const FObject Check = Find(Arr(CandidateState, TEXT("checks")), Str(ReviewRecord, TEXT("checkId")));
        if (Same(Str(Check, TEXT("status")), TEXT("stale"))) ReviewRecord->SetStringField(TEXT("status"), TEXT("stale"));
    }
    CandidateState->SetObjectField(TEXT("project"), Next);
    if (!FCodec::Validate(CandidateState, OutError)) return false;
    const FObject Change = MakeShared<FJsonObject>();
    Change->SetNumberField(TEXT("revision"), Revision(Next));
    Change->SetArrayField(TEXT("changedIds"), Values(ChangedIds(Arr(Before, TEXT("records")), Records)));
    Change->SetStringField(TEXT("label"), Label);
    // Freeze all aliases before publishing the authoritative state.
    State = FCodec::Clone(CandidateState);
    OutChange = Change;
    OutError.Reset();
    return true;
}

bool FSpatialPrevisProjectStore::UniqueId(const FString& Id, FString& OutError) const
{
    if (!State.IsValid()) return Fail(OutError, TEXT("Workspace is not initialized"));
    if (!Nonempty(Id) || Find(Arr(Obj(State, TEXT("project")), TEXT("records")), Id).IsValid())
        return Fail(OutError, TEXT("ID must be new and nonempty"));
    for (const TCHAR* Field : {TEXT("checks"), TEXT("reviews"), TEXT("issued")})
        if (Find(Arr(State, Field), Id).IsValid()) return Fail(OutError, TEXT("ID must be new and nonempty"));
    return true;
}

bool FSpatialPrevisProjectStore::RecordCheck(const FObject& Result, double BaseRevision,
    FObject& OutCheck, FString& OutError)
{
    if (!State.IsValid() || !Result.IsValid()) return Fail(OutError, TEXT("Workspace and check result are required"));
    const FObject Check = FCodec::Clone(Result);
    const FObject Project = GetProject();
    if (BaseRevision != Revision(Project)) return Fail(OutError, TEXT("Stale calculation result"));
    TArray<FString> Scope;
    if (!Strings(Check, TEXT("scope"), Scope) || Scope.IsEmpty()) return Fail(OutError, TEXT("Unknown check scope"));
    for (const FString& Id : Scope)
        if (!Find(Arr(Project, TEXT("records")), Id).IsValid()) return Fail(OutError, TEXT("Unknown check scope"));
    if (!UniqueId(Str(Check, TEXT("id")), OutError)) return false;
    FString Hash;
    if (!FCodec::InputHash(Project, Scope, Str(Check, TEXT("model")), Str(Check, TEXT("modelVersion")), Hash, OutError)) return false;
    if (Revision(Obj(State, TEXT("project"))) != BaseRevision) return Fail(OutError, TEXT("Calculation inputs changed while running"));
    if (!UniqueId(Str(Check, TEXT("id")), OutError)) return false;
    Check->SetStringField(TEXT("inputHash"), Hash);
    Check->SetNumberField(TEXT("inputRevision"), BaseRevision);
    const FObject Candidate = GetWorkspace();
    FValues Checks = Arr(Candidate, TEXT("checks")); Checks.Add(Value(Check));
    Candidate->SetArrayField(TEXT("checks"), Checks);
    if (!FCodec::Validate(Candidate, OutError)) return false;
    State = Candidate;
    OutCheck = FCodec::Clone(Check);
    OutError.Reset();
    return true;
}

bool FSpatialPrevisProjectStore::Review(const FString& CheckId, const FString& ReviewId, const TArray<FString>& Evidence,
    const FSpatialPrevisPrincipal& Principal, FObject& OutReview, FString& OutError)
{
    return Review(CheckId, ReviewId, Evidence, Principal, OutReview, OutError, FDateTime::UtcNow().ToIso8601());
}

bool FSpatialPrevisProjectStore::Review(const FString& CheckId, const FString& ReviewId, const TArray<FString>& Evidence,
    const FSpatialPrevisPrincipal& Principal, FObject& OutReview, FString& OutError, const FString& Now)
{
    const FObject Check = Find(Arr(State, TEXT("checks")), CheckId);
    if (!Check.IsValid() || !Same(Str(Check, TEXT("status")), TEXT("pass"))) return Fail(OutError, TEXT("Only a current passing scoped check can be reviewed"));
    if (!Permit(Principal, TEXT("review"), Strings(Check, TEXT("scope")), OutError)) return false;
    if (Evidence.IsEmpty()) return Fail(OutError, TEXT("Review evidence is required"));
    if (!UniqueId(ReviewId, OutError)) return false;
    const FObject ReviewRecord = MakeShared<FJsonObject>();
    ReviewRecord->SetStringField(TEXT("id"), ReviewId);
    ReviewRecord->SetStringField(TEXT("checkId"), CheckId);
    ReviewRecord->SetStringField(TEXT("reviewerId"), Principal.Id);
    ReviewRecord->SetStringField(TEXT("reviewedAt"), Now);
    ReviewRecord->SetStringField(TEXT("inputHash"), Str(Check, TEXT("inputHash")));
    ReviewRecord->SetField(TEXT("inputRevision"), Field(Check, TEXT("inputRevision")));
    ReviewRecord->SetStringField(TEXT("status"), TEXT("current"));
    ReviewRecord->SetArrayField(TEXT("evidence"), Values(Evidence));
    const FObject Candidate = GetWorkspace();
    FValues Reviews = Arr(Candidate, TEXT("reviews")); Reviews.Add(Value(ReviewRecord));
    Candidate->SetArrayField(TEXT("reviews"), Reviews);
    if (!FCodec::Validate(Candidate, OutError)) return false;
    State = FCodec::Clone(Candidate);
    OutReview = FCodec::Clone(ReviewRecord);
    OutError.Reset();
    return true;
}

bool FSpatialPrevisProjectStore::Issue(const FString& Id, const TArray<FString>& RequiredCheckIds,
    const FSpatialPrevisPrincipal& Principal, FObject& OutArtifact, FString& OutError)
{
    return Issue(Id, RequiredCheckIds, Principal, OutArtifact, OutError, FDateTime::UtcNow().ToIso8601());
}

bool FSpatialPrevisProjectStore::Issue(const FString& Id, const TArray<FString>& RequiredCheckIds,
    const FSpatialPrevisPrincipal& Principal, FObject& OutArtifact, FString& OutError, const FString& Now)
{
    if (!Permit(Principal, TEXT("issue"), RequiredCheckIds, OutError)) return false;
    if (!UniqueId(Id, OutError)) return false;
    if (RequiredCheckIds.IsEmpty()) return Fail(OutError, TEXT("An explicit reviewed check scope is required to issue"));
    TArray<FString> ReviewIds;
    for (const FString& CheckId : RequiredCheckIds)
    {
        const FObject Check = Find(Arr(State, TEXT("checks")), CheckId);
        FObject CurrentReview;
        for (const FValue& Item : Arr(State, TEXT("reviews")))
        {
            const FObject ReviewRecord = AsObj(Item);
            if (Same(Str(ReviewRecord, TEXT("checkId")), CheckId) && Same(Str(ReviewRecord, TEXT("status")), TEXT("current"))
                && Same(Str(ReviewRecord, TEXT("inputHash")), Str(Check, TEXT("inputHash")))) { CurrentReview = ReviewRecord; break; }
        }
        if (!Same(Str(Check, TEXT("status")), TEXT("pass")) || !CurrentReview.IsValid()) return Fail(OutError, TEXT("Missing current review: ") + CheckId);
        ReviewIds.Add(Str(CurrentReview, TEXT("id")));
    }
    FString Content;
    const FObject Project = Obj(State, TEXT("project"));
    if (!FSpatialPrevisProjectCodec::Serialize(Project, Content, OutError)) return false;
    const FObject Artifact = MakeShared<FJsonObject>();
    Artifact->SetStringField(TEXT("id"), Id);
    Artifact->SetNumberField(TEXT("projectRevision"), Revision(Project));
    Artifact->SetStringField(TEXT("issuerId"), Principal.Id);
    Artifact->SetStringField(TEXT("issuedAt"), Now);
    Artifact->SetStringField(TEXT("mediaType"), TEXT("application/json"));
    Artifact->SetStringField(TEXT("content"), Content);
    Artifact->SetArrayField(TEXT("reviewIds"), Values(ReviewIds));
    const FObject Candidate = GetWorkspace();
    FValues Artifacts = Arr(Candidate, TEXT("issued")); Artifacts.Add(Value(Artifact));
    Candidate->SetArrayField(TEXT("issued"), Artifacts);
    if (!FCodec::Validate(Candidate, OutError)) return false;
    State = Candidate;
    OutArtifact = FCodec::Clone(Artifact);
    OutError.Reset();
    return true;
}

bool FSpatialPrevisProjectStore::DeleteInstanceOperations(const FObject& Project, const FString& InstanceId,
    FValues& OutOperations, FString& OutError)
{
    if (!FSpatialPrevisProjectCodec::Validate(Project, OutError)) return false;
    const FValues Records = Arr(Project, TEXT("records"));
    if (!Same(Str(Find(Records, InstanceId), TEXT("kind")), TEXT("asset_instance"))) return Fail(OutError, TEXT("Unknown instance"));
    TArray<FString> Removed = {InstanceId};
    for (const FValue& Item : Records)
    {
        const FObject Record = AsObj(Item);
        if (Same(Str(Record, TEXT("kind")), TEXT("port")) && Same(Str(Record, TEXT("instanceId")), InstanceId))
            AddUnique(Removed, Str(Record, TEXT("id")));
    }
    for (const FValue& Item : Records)
    {
        const FObject Record = AsObj(Item);
        const FString Kind = Str(Record, TEXT("kind"));
        if (!Same(Kind, TEXT("connection")) && !Same(Kind, TEXT("mechanical_attachment"))) continue;
        for (const FString& Ref : FCodec::References(Record))
            if (Has(Removed, Ref)) { AddUnique(Removed, Str(Record, TEXT("id"))); break; }
    }
    FValues Operations;
    for (const FString& Id : Removed) Operations.Add(Value(RemoveOperation(Id)));
    for (const FValue& Item : Records)
    {
        const FObject Record = AsObj(Item);
        if (!Same(Str(Record, TEXT("kind")), TEXT("assembly"))) continue;
        TArray<FString> InstanceIds = Strings(Record, TEXT("instanceIds"));
        if (!Has(InstanceIds, InstanceId)) continue;
        InstanceIds.RemoveAll([&InstanceId](const FString& Item) { return Same(Item, InstanceId); });
        const FObject Replacement = FCodec::Clone(Record);
        Replacement->SetArrayField(TEXT("instanceIds"), Values(InstanceIds));
        Operations.Add(Value(PutOperation(Replacement)));
    }
    OutOperations = MoveTemp(Operations);
    OutError.Reset();
    return true;
}

bool FSpatialPrevisProjectStore::TranslateInstanceOperations(const FObject& Project, const FString& InstanceId,
    const FVector3d& PositionMetres, FValues& OutOperations, FString& OutError)
{
    if (!FSpatialPrevisProjectCodec::Validate(Project, OutError)) return false;
    const FValues Records = Arr(Project, TEXT("records"));
    const FObject Root = Find(Records, InstanceId);
    if (!Same(Str(Root, TEXT("kind")), TEXT("asset_instance"))) return Fail(OutError, TEXT("Select an equipment instance"));
    if (!FMath::IsFinite(PositionMetres.X) || !FMath::IsFinite(PositionMetres.Y) || !FMath::IsFinite(PositionMetres.Z))
        return Fail(OutError, TEXT("Position requires finite metres"));
    TSet<FExactString> Ids = {FExactString(InstanceId)};
    for (bool bGrew = true; bGrew;)
    {
        bGrew = false;
        for (const FValue& Item : Records)
        {
            const FObject Record = AsObj(Item);
            if (Same(Str(Record, TEXT("kind")), TEXT("mechanical_attachment"))
                && Ids.Contains(Str(Record, TEXT("parentInstanceId"))) && !Ids.Contains(Str(Record, TEXT("childInstanceId"))))
            {
                Ids.Add(Str(Record, TEXT("childInstanceId")));
                bGrew = true;
            }
        }
    }
    const FValues OldPosition = Arr(Obj(Root, TEXT("transform")), TEXT("position"));
    const FVector3d Delta = PositionMetres - FVector3d(OldPosition[0]->AsNumber(), OldPosition[1]->AsNumber(), OldPosition[2]->AsNumber());
    FValues Operations;
    for (const FValue& Item : Records)
    {
        const FObject Record = AsObj(Item);
        if (!Same(Str(Record, TEXT("kind")), TEXT("asset_instance")) || !Ids.Contains(Str(Record, TEXT("id")))) continue;
        const FObject Replacement = FCodec::Clone(Record);
        const FObject Transform = Obj(Replacement, TEXT("transform"));
        const FValues Position = Arr(Transform, TEXT("position"));
        Transform->SetArrayField(TEXT("position"), {MakeShared<FJsonValueNumber>(Position[0]->AsNumber() + Delta.X),
            MakeShared<FJsonValueNumber>(Position[1]->AsNumber() + Delta.Y), MakeShared<FJsonValueNumber>(Position[2]->AsNumber() + Delta.Z)});
        Operations.Add(Value(PutOperation(Replacement)));
    }
    if (Delta.X != 0 || Delta.Y != 0 || Delta.Z != 0)
    {
        for (const FValue& Item : Records)
        {
            const FObject Record = AsObj(Item);
            if (Same(Str(Record, TEXT("kind")), TEXT("mechanical_attachment")) && Same(Str(Record, TEXT("childInstanceId")), InstanceId))
            {
                Operations.Add(Value(RemoveOperation(Str(Record, TEXT("id")))));
                break;
            }
        }
    }
    OutOperations = MoveTemp(Operations);
    OutError.Reset();
    return true;
}

bool FSpatialPrevisProjectStore::TechnicalDataCheck(const FObject& Project, const FObject& Record,
    const FString& Id, FObject& OutResult, FString& OutError)
{
    if (!FSpatialPrevisProjectCodec::Validate(Project, OutError)) return false;
    if (!Record.IsValid()) return Fail(OutError, TEXT("A record is required"));
    const FString Kind = Str(Record, TEXT("kind"));
    TArray<FObject> Definitions;
    if (Same(Kind, TEXT("asset_instance")))
    {
        const FObject Definition = Find(Arr(Project, TEXT("records")), Str(Record, TEXT("definitionId")));
        if (Definition.IsValid()) Definitions.Add(Definition);
    }
    else Definitions.Add(Record);
    TArray<FString> Unknowns;
    for (const FObject& Target : Definitions)
    {
        const FString TargetKind = Str(Target, TEXT("kind"));
        if (Same(TargetKind, TEXT("asset_definition")))
        {
            const FObject Specifications = Obj(Target, TEXT("specifications"));
            if (!Specifications.IsValid()) return Fail(OutError, TEXT("Invalid technical specifications"));
            if (Specifications->Values.IsEmpty()) Unknowns.Add(TEXT("technical specifications"));
            for (const auto& Pair : Specifications->Values)
            {
                const FObject Quantity = AsObj(Pair.Value);
                if (Same(Str(Quantity, TEXT("status")), TEXT("unknown")) || Same(Str(Quantity, TEXT("provenance")), TEXT("placeholder"))) Unknowns.Add(FString(Pair.Key.Len(), *Pair.Key));
            }
        }
        if (Same(TargetKind, TEXT("port")))
        {
            for (const TCHAR* Field : {TEXT("connector"), TEXT("protocol")})
            {
                const FValue FieldValue = SpatialPrevisStore::Field(Target, Field);
                if (FieldValue.IsValid() && FieldValue->Type == EJson::Null) Unknowns.Add(Field);
            }
        }
        if (Same(TargetKind, TEXT("surface")))
        {
            for (const TCHAR* Field : {TEXT("width"), TEXT("height")})
            {
                const FObject Quantity = Obj(Target, Field);
                if (Same(Str(Quantity, TEXT("status")), TEXT("unknown")) || Same(Str(Quantity, TEXT("provenance")), TEXT("placeholder"))) Unknowns.Add(Field);
            }
        }
    }
    const bool bApplicable = Same(Kind, TEXT("asset_instance")) || Same(Kind, TEXT("asset_definition")) || Same(Kind, TEXT("port")) || Same(Kind, TEXT("surface"));
    const FObject Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("id"), Id);
    Result->SetArrayField(TEXT("scope"), {Value(Str(Record, TEXT("id")))});
    Result->SetStringField(TEXT("model"), TEXT("technical-data-presence"));
    Result->SetStringField(TEXT("modelVersion"), TEXT("1"));
    Result->SetStringField(TEXT("status"), !bApplicable ? TEXT("not_evaluated") : Unknowns.IsEmpty() ? TEXT("pass") : TEXT("needs_data"));
    Result->SetStringField(TEXT("summary"), !bApplicable ? TEXT("No technical-data check is defined for this record type")
        : Unknowns.IsEmpty() ? TEXT("Recorded fields are populated; engineering performance is not evaluated") : TEXT("Needs data: ") + FString::Join(Unknowns, TEXT(", ")));
    Result->SetArrayField(TEXT("assumptions"), {Value(FString(TEXT("Checks recorded data presence only; source authenticity and physical suitability are not verified")))});
    Result->SetArrayField(TEXT("uncertainty"), {Value(FString(TEXT("No electrical, structural, acoustic, optical or laser safety calculation is performed")))});
    Result->SetArrayField(TEXT("evidence"), bApplicable ? FValues{Value(FString(TEXT("Current project records")))} : FValues{});
    OutResult = Result;
    OutError.Reset();
    return true;
}
