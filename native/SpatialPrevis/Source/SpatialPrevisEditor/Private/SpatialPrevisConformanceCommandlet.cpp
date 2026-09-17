#include "SpatialPrevisConformanceCommandlet.h"
#include "SpatialPrevisProjectCodec.h"
#include "SpatialPrevisUnrealTransform.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/FileManager.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

USpatialPrevisConformanceCommandlet::USpatialPrevisConformanceCommandlet()
{
    IsClient = false; IsServer = false; IsEditor = true; LogToConsole = true;
}

int32 USpatialPrevisConformanceCommandlet::Main(const FString& Params)
{
    FString FixturePath, ReportPath;
    if (!FParse::Value(*Params, TEXT("Corpus="), FixturePath)
        || !FParse::Value(*Params, TEXT("Report="), ReportPath))
    {
        UE_LOG(LogTemp, Error, TEXT("Requires -Corpus=<project-conformance.v1.json> -Report=<new report path>"));
        return 2;
    }
    // Evidence is append-only by filename; a failed rerun must not erase prior results.
    if (IFileManager::Get().FileExists(*ReportPath))
    {
        UE_LOG(LogTemp, Error, TEXT("Report path already exists; choose a new evidence path."));
        return 2;
    }
    FString Text;
    TSharedPtr<FJsonObject> Corpus;
    if (!FFileHelper::LoadFileToString(Text, *FixturePath)
        || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Corpus) || !Corpus.IsValid())
    {
        UE_LOG(LogTemp, Error, TEXT("Cannot read conformance corpus.")); return 2;
    }
    FString Format; double Version = 0;
    const TArray<TSharedPtr<FJsonValue>>* Cases = nullptr;
    if (!Corpus->TryGetStringField(TEXT("format"), Format) || Format != TEXT("spatial-previs-project-conformance")
        || !Corpus->TryGetNumberField(TEXT("version"), Version) || Version != 1
        || !Corpus->TryGetArrayField(TEXT("cases"), Cases) || Cases->IsEmpty())
    { UE_LOG(LogTemp, Error, TEXT("Unsupported or empty corpus.")); return 2; }

    int32 Failures = 0;
    TSet<FString> SeenIds;
    TArray<TSharedPtr<FJsonValue>> Results;
    for (const auto& Item : *Cases)
    {
        if (!Item.IsValid() || Item->Type != EJson::Object) return 2;
        const auto Test = Item->AsObject();
        FString Id; bool Expected = false;
        FString Json;
        if (!Test->TryGetStringField(TEXT("id"), Id) || Id.IsEmpty() || SeenIds.Contains(Id)
            || !Test->TryGetBoolField(TEXT("valid"), Expected)
            || !Test->TryGetStringField(TEXT("json"), Json)) return 2;
        SeenIds.Add(Id);
        FString Error;
        TSharedPtr<FJsonObject> Project;
        const bool Accepted = FSpatialPrevisProjectCodec::Parse(Json, Project, Error);
        const auto Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("id"), Id);
        Result->SetBoolField(TEXT("accepted"), Accepted);
        bool Passed = Accepted == Expected;
        if (Accepted)
        {
            FString Export;
            TSharedPtr<FJsonObject> Reopened;
            Passed &= FSpatialPrevisProjectCodec::Serialize(Project, Export, Error)
                && FSpatialPrevisProjectCodec::Parse(Export, Reopened, Error);
            // Keep the codec's exact binary64 JSON in a string. The report writer
            // must not round numeric fields through its own formatting policy.
            if (Reopened.IsValid()) Result->SetStringField(TEXT("projectJson"), Export);
        }
        Result->SetBoolField(TEXT("passed"), Passed);
        Result->SetStringField(TEXT("error"), Error);
        Results.Add(MakeShared<FJsonValueObject>(Result));
        if (!Passed) { ++Failures; UE_LOG(LogTemp, Error, TEXT("Conformance failed: %s: %s"), *Id, *Error); }
    }

    TArray<TSharedPtr<FJsonValue>> SyntaxResults;
    const TArray<TSharedPtr<FJsonValue>>* SyntaxCases = nullptr;
    if (!Corpus->TryGetArrayField(TEXT("syntaxCases"), SyntaxCases) || SyntaxCases->IsEmpty()) return 2;
    for (const auto& Item : *SyntaxCases)
    {
        if (!Item.IsValid() || Item->Type != EJson::Object) return 2;
        const auto Test = Item->AsObject();
        FString Id, Json, Error; bool Expected = true;
        if (!Test->TryGetStringField(TEXT("id"), Id) || Id.IsEmpty() || SeenIds.Contains(Id)
            || !Test->TryGetStringField(TEXT("json"), Json)
            || !Test->TryGetBoolField(TEXT("valid"), Expected) || Expected) return 2;
        SeenIds.Add(Id);
        TSharedPtr<FJsonObject> Active;
        FString ActiveError;
        const FString EmptyProject = TEXT("{\"schemaVersion\":1,\"projectId\":\"unchanged\",\"revision\":0,\"coordinateFrame\":\"right_handed_y_up_meters\",\"records\":[]}");
        if (!FSpatialPrevisProjectCodec::Parse(EmptyProject, Active, ActiveError)) return 2;
        const auto Before = Active;
        const bool Accepted = FSpatialPrevisProjectCodec::Parse(Json, Active, Error);
        const bool Passed = !Accepted && Active == Before;
        const auto Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("id"), Id);
        Result->SetBoolField(TEXT("accepted"), Accepted);
        Result->SetBoolField(TEXT("passed"), Passed);
        SyntaxResults.Add(MakeShared<FJsonValueObject>(Result));
        if (!Passed) ++Failures;
    }

    // Execute the actual FQuat/FTransform adapter as well as the portable maths.
    bool CoordinatesPassed = true;
    const double H = FMath::Sqrt(0.5), N = FMath::Sqrt(30.0);
    const SpatialPrevisCoordinates::Quaternion Rotations[] = {
        {0,0,0,1}, {H,0,0,H}, {0,H,0,H}, {0,0,H,H}, {1/N,2/N,3/N,4/N}
    };
    const FVector Vectors[] = {FVector(1,0,0), FVector(0,1,0), FVector(0,0,1), FVector(-2,3.5,4)};
    for (auto Q : Rotations)
    {
        const FTransform Native = SpatialPrevisTransform::ToNative({1,2,3}, Q);
        CoordinatesPassed &= Native.GetTranslation().Equals(FVector(-300,100,200), 1e-9);
        const FQuat Source(Q.X,Q.Y,Q.Z,Q.W);
        for (const auto& V : Vectors)
        {
            const auto M = SpatialPrevisCoordinates::ToNativeDirection({V.X,V.Y,V.Z});
            const FVector Rotated = Source.RotateVector(V);
            const auto Expected = SpatialPrevisCoordinates::ToNativeDirection({Rotated.X,Rotated.Y,Rotated.Z});
            CoordinatesPassed &= Native.GetRotation().RotateVector(FVector(M.X,M.Y,M.Z))
                .Equals(FVector(Expected.X,Expected.Y,Expected.Z), 1e-9);
        }
    }
    if (!CoordinatesPassed) ++Failures;
    const auto Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("format"), TEXT("spatial-previs-native-conformance"));
    Report->SetNumberField(TEXT("version"), 1);
    Report->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
    Report->SetStringField(TEXT("scope"), TEXT("CORE-01 project codec and coordinate boundary only"));
    Report->SetBoolField(TEXT("coordinatesPassed"), CoordinatesPassed);
    Report->SetNumberField(TEXT("failures"), Failures);
    Report->SetArrayField(TEXT("cases"), Results);
    Report->SetArrayField(TEXT("syntaxCases"), SyntaxResults);
    FString ReportJson;
    FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&ReportJson));
    IFileManager::Get().MakeDirectory(*FPaths::GetPath(ReportPath), true);
    if (!FFileHelper::SaveStringToFile(ReportJson, *ReportPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) return 2;
    UE_LOG(LogTemp, Display, TEXT("Native CORE-01 cases: %d; failures: %d"), Cases->Num(), Failures);
    return Failures == 0 ? 0 : 1;
}
