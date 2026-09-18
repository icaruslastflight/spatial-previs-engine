#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"

#include "DesktopPlatformModule.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Framework/Application/SlateApplication.h"
#include "Framework/Commands/UIAction.h"
#include "Framework/Docking/TabManager.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "IDesktopPlatform.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/MessageDialog.h"
#include "Misc/Paths.h"
#include "Policies/PrettyJsonPrintPolicy.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "SpatialPrevisCoordinates.h"
#include "SpatialPrevisProjectCodec.h"
#include "SpatialPrevisUnrealTransform.h"
#include "SpatialPrevisWorkspaceCodec.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Kismet/GameplayStatics.h"
#include "Textures/SlateIcon.h"
#include "ToolMenus.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Views/SHeaderRow.h"
#include "Widgets/Views/SListView.h"
#include "Widgets/Views/STableRow.h"

#define LOCTEXT_NAMESPACE "SpatialPrevisEditor"

namespace SpatialPrevisEditor
{
const FName TabName(TEXT("SpatialPrevisR0"));
using FRecordItem = TSharedPtr<FJsonObject>;

/** Rows reference the validated project itself; there is no editable second model. */
class SProjectRecordRow : public SMultiColumnTableRow<FRecordItem>
{
public:
    SLATE_BEGIN_ARGS(SProjectRecordRow) {}
        SLATE_ARGUMENT(FRecordItem, Record)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs, const TSharedRef<STableViewBase>& OwnerTable)
    {
        Record = InArgs._Record;
        SMultiColumnTableRow<FRecordItem>::Construct(
            SMultiColumnTableRow<FRecordItem>::FArguments().Padding(6.0f), OwnerTable);
    }

    virtual TSharedRef<SWidget> GenerateWidgetForColumn(const FName& ColumnName) override
    {
        FString Value;
        if (ColumnName == TEXT("Locked"))
        {
            Value = Record->GetBoolField(TEXT("locked")) ? TEXT("Locked") : TEXT("Unlocked");
        }
        else
        {
            const FString Field = ColumnName == TEXT("Kind") ? TEXT("kind")
                : ColumnName == TEXT("Id") ? TEXT("id") : TEXT("label");
            Value = Record->GetStringField(Field);
        }
        return SNew(STextBlock).Text(FText::FromString(Value)).ToolTipText(FText::FromString(Value));
    }

private:
    FRecordItem Record;
};

class SProjectInspectionPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SProjectInspectionPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments&)
    {
        Summary = LOCTEXT("EmptySummary", "No project imported.");
        Status = LOCTEXT("InitialStatus",
            "Import project JSON to inspect it. The imported file remains unchanged. Export creates a separate project file.");
        Detail = LOCTEXT("EmptyDetails", "Select a record to inspect its complete JSON, including references and quantities.");

        ChildSlot
        [
            SNew(SBorder)
            .Padding(16.0f)
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
                [
                    SNew(STextBlock)
                    .Text(LOCTEXT("Heading", "Spatial Previs | R1 Native Workspace & Level Integration"))
                ]
                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12)
                [
                    SNew(STextBlock)
                    .AutoWrapText(true)
                    .Text(LOCTEXT("Scope",
                        "R1 native workspace and level sync. Supports both bare project JSON and full workspace envelopes, with direct level actor spawning and exact native metre-to-centimetre coordinate conversion."))
                ]
                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12)
                [
                    SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 8, 0)
                    [
                        SNew(SButton)
                        .Text(LOCTEXT("Import", "Import project / workspace..."))
                        .ToolTipText(LOCTEXT("ImportTooltip", "Load and validate a bare project or complete workspace envelope JSON file. A failed import preserves the active project."))
                        .OnClicked(this, &SProjectInspectionPanel::ImportProject)
                    ]
                    + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 8, 0)
                    [
                        SNew(SButton)
                        .Text(LOCTEXT("Export", "Export project JSON as..."))
                        .ToolTipText(LOCTEXT("ExportTooltip", "Validate and export the active project to a different path. Existing destination files require confirmation."))
                        .IsEnabled(this, &SProjectInspectionPanel::HasProject)
                        .OnClicked(this, &SProjectInspectionPanel::ExportProject)
                    ]
                    + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 8, 0)
                    [
                        SNew(SButton)
                        .Text(LOCTEXT("SpawnActors", "Spawn Level Actors"))
                        .ToolTipText(LOCTEXT("SpawnActorsTooltip", "Instantiate and position 3D scene actors in the active level for all asset instances using native coordinates."))
                        .IsEnabled(this, &SProjectInspectionPanel::HasProject)
                        .OnClicked(this, &SProjectInspectionPanel::SpawnLevelActors)
                    ]
                    + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 8, 0)
                    [
                        SNew(SButton)
                        .Text(LOCTEXT("ClearActors", "Clear Level Actors"))
                        .ToolTipText(LOCTEXT("ClearActorsTooltip", "Remove all spawned Spatial Previs actors from the active level."))
                        .OnClicked(this, &SProjectInspectionPanel::ClearLevelActors)
                    ]
                    + SHorizontalBox::Slot().AutoWidth()
                    [
                        SNew(SButton)
                        .Text(LOCTEXT("LaunchShowcase", "Launch Stage Showcase"))
                        .ToolTipText(LOCTEXT("LaunchShowcaseTooltip", "Launch the concert stage showcase in your default desktop browser (Claypaky Sharpys, EDM video wall, volumetric beams, and laser MPE evaluation)."))
                        .OnClicked(this, &SProjectInspectionPanel::LaunchStageShowcase)
                    ]
                ]
                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
                [
                    SNew(STextBlock).Text(this, &SProjectInspectionPanel::GetSummary).AutoWrapText(true)
                ]
                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12)
                [
                    SNew(STextBlock).Text(this, &SProjectInspectionPanel::GetSource).AutoWrapText(true)
                ]
                + SVerticalBox::Slot().FillHeight(1.0f)
                [
                    SNew(SSplitter)
                    .Orientation(Orient_Vertical)
                    + SSplitter::Slot().Value(0.6f)
                    [
                        SAssignNew(RecordList, SListView<FRecordItem>)
                        .ListItemsSource(&Records)
                        .SelectionMode(ESelectionMode::Single)
                        .OnGenerateRow(this, &SProjectInspectionPanel::GenerateRecordRow)
                        .OnSelectionChanged(this, &SProjectInspectionPanel::SelectRecord)
                        .HeaderRow
                        (
                            SNew(SHeaderRow)
                            + SHeaderRow::Column(TEXT("Kind")).DefaultLabel(LOCTEXT("KindColumn", "Kind")).FillWidth(0.22f)
                            + SHeaderRow::Column(TEXT("Id")).DefaultLabel(LOCTEXT("IdColumn", "Record ID")).FillWidth(0.35f)
                            + SHeaderRow::Column(TEXT("Label")).DefaultLabel(LOCTEXT("LabelColumn", "Label")).FillWidth(0.30f)
                            + SHeaderRow::Column(TEXT("Locked")).DefaultLabel(LOCTEXT("LockColumn", "Lock state")).FillWidth(0.13f)
                        )
                    ]
                    + SSplitter::Slot().Value(0.4f)
                    [
                        SNew(SVerticalBox)
                        + SVerticalBox::Slot().AutoHeight().Padding(0, 8, 0, 6)
                        [
                            SNew(STextBlock).Text(LOCTEXT("DetailHeading", "Selected record | read-only JSON (select text to copy)"))
                        ]
                        + SVerticalBox::Slot().FillHeight(1.0f)
                        [
                            SNew(SMultiLineEditableTextBox)
                            .Text(this, &SProjectInspectionPanel::GetDetail)
                            .IsReadOnly(true)
                            .AutoWrapText(true)
                        ]
                    ]
                ]
                + SVerticalBox::Slot().AutoHeight().Padding(0, 12, 0, 0)
                [
                    SNew(STextBlock).Text(this, &SProjectInspectionPanel::GetStatus).AutoWrapText(true)
                ]
            ]
        ];
    }

private:
    // Only a successful whole-project parse may replace this document.
    TSharedPtr<FJsonObject> ActiveProject;
    TSharedPtr<FJsonObject> ActiveWorkspace;
    TArray<FRecordItem> Records;
    TSharedPtr<SListView<FRecordItem>> RecordList;
    FString SourcePath;
    FText Summary;
    FText Detail;
    FText Status;

    bool HasProject() const { return ActiveProject.IsValid(); }
    FText GetSummary() const { return Summary; }
    FText GetDetail() const { return Detail; }
    FText GetStatus() const { return Status; }
    FText GetSource() const
    {
        return SourcePath.IsEmpty() ? LOCTEXT("NoSource", "Source: none")
            : FText::FromString(FString::Printf(TEXT("Source: %s"), *SourcePath));
    }

    TSharedRef<ITableRow> GenerateRecordRow(FRecordItem Item, const TSharedRef<STableViewBase>& OwnerTable)
    {
        return SNew(SProjectRecordRow, OwnerTable).Record(Item);
    }

    void SelectRecord(FRecordItem Item, ESelectInfo::Type)
    {
        if (!Item.IsValid())
        {
            Detail = LOCTEXT("EmptyDetails", "Select a record to inspect its complete JSON, including references and quantities.");
            return;
        }
        FString Json;
        const TSharedRef<TJsonWriter<TCHAR, TPrettyJsonPrintPolicy<TCHAR>>> Writer =
            TJsonWriterFactory<TCHAR, TPrettyJsonPrintPolicy<TCHAR>>::Create(&Json);
        if (FJsonSerializer::Serialize(Item.ToSharedRef(), Writer))
        {
            Detail = FText::FromString(Json);
        }
        else
        {
            Detail = LOCTEXT("DetailError", "Could not display this record. The active project is unchanged.");
        }
    }

    void ReportFailure(const FString& Message)
    {
        Status = FText::FromString(Message + (HasProject()
            ? TEXT(" Active project preserved.") : TEXT(" No project loaded.")));
    }

    FReply ImportProject()
    {
        IDesktopPlatform* Desktop = FDesktopPlatformModule::Get();
        if (!Desktop)
        {
            ReportFailure(TEXT("File dialogs are unavailable on this platform."));
            return FReply::Handled();
        }

        TArray<FString> Paths;
        const FString StartDirectory = SourcePath.IsEmpty() ? FPaths::ProjectDir() : FPaths::GetPath(SourcePath);
        if (!Desktop->OpenFileDialog(
            FSlateApplication::Get().FindBestParentWindowHandleForDialogs(AsShared()),
            TEXT("Import Spatial Previs project JSON"), StartDirectory, TEXT(""),
            TEXT("Project JSON (*.json)|*.json"), 0, Paths) || Paths.IsEmpty())
        {
            Status = LOCTEXT("ImportCancelled", "Import cancelled. Active project unchanged.");
            return FReply::Handled();
        }

        FString Json;
        if (!FFileHelper::LoadFileToString(Json, *Paths[0]))
        {
            ReportFailure(FString::Printf(TEXT("Could not read %s."), *Paths[0]));
            return FReply::Handled();
        }
        FString Error;
        TSharedPtr<FJsonObject> Candidate;
        TSharedPtr<FJsonObject> CandidateWorkspace;
        bool bIsWorkspace = false;

        if (FSpatialPrevisWorkspaceCodec::Parse(Json, CandidateWorkspace, Error))
        {
            Candidate = CandidateWorkspace->GetObjectField(TEXT("project"));
            ActiveWorkspace = CandidateWorkspace;
            bIsWorkspace = true;
        }
        else
        {
            FString ProjectError;
            if (!FSpatialPrevisProjectCodec::Parse(Json, Candidate, ProjectError))
            {
                ReportFailure(FString::Printf(TEXT("Import rejected. Workspace error: %s | Project error: %s"), *Error, *ProjectError));
                return FReply::Handled();
            }
            ActiveWorkspace.Reset();
        }

        // Validation is transactional: no row, source path or selection changes on failure.
        ActiveProject = Candidate;
        SourcePath = FPaths::ConvertRelativePathToFull(Paths[0]);
        RecordList->ClearSelection();
        Records.Reset();
        for (const TSharedPtr<FJsonValue>& Value : ActiveProject->GetArrayField(TEXT("records")))
        {
            Records.Add(Value->AsObject());
        }
        RecordList->RequestListRefresh();
        Detail = LOCTEXT("EmptyDetails", "Select a record to inspect its complete JSON, including references and quantities.");
        RefreshSummary();
        Status = bIsWorkspace
            ? LOCTEXT("WorkspaceImportSuccess", "Workspace envelope imported and validated. Records, history and review evidence preserved. Ready to spawn level actors.")
            : LOCTEXT("ImportSuccess", "Project imported and validated. Records, quantities, references and revision preserved. Ready to spawn level actors.");
        return FReply::Handled();
    }

    FReply ExportProject()
    {
        if (!HasProject())
        {
            return FReply::Handled();
        }
        FString Json;
        FString Error;
        if (!FSpatialPrevisProjectCodec::Serialize(ActiveProject, Json, Error))
        {
            ReportFailure(TEXT("Export validation failed: ") + Error);
            return FReply::Handled();
        }
        IDesktopPlatform* Desktop = FDesktopPlatformModule::Get();
        if (!Desktop)
        {
            ReportFailure(TEXT("File dialogs are unavailable on this platform."));
            return FReply::Handled();
        }

        TArray<FString> Paths;
        const FString DefaultName = FPaths::GetBaseFilename(SourcePath) + TEXT("-native-export.json");
        if (!Desktop->SaveFileDialog(
            FSlateApplication::Get().FindBestParentWindowHandleForDialogs(AsShared()),
            TEXT("Export Spatial Previs project JSON as"), FPaths::GetPath(SourcePath), DefaultName,
            TEXT("Project JSON (*.json)|*.json"), 0, Paths) || Paths.IsEmpty())
        {
            Status = LOCTEXT("ExportCancelled", "Export cancelled. Active project unchanged.");
            return FReply::Handled();
        }
        FString Destination = FPaths::ConvertRelativePathToFull(Paths[0]);
        if (FPaths::GetExtension(Destination).IsEmpty())
        {
            Destination += TEXT(".json");
        }
        if (FPaths::IsSamePath(Destination, SourcePath))
        {
            ReportFailure(TEXT("Choose a different export path to preserve the imported source file."));
            return FReply::Handled();
        }
        const bool bDestinationExists = IFileManager::Get().FileExists(*Destination);
        if (bDestinationExists && FMessageDialog::Open(EAppMsgType::YesNo,
            FText::FromString(FString::Printf(TEXT("Replace the existing file?\n%s"), *Destination))) != EAppReturnType::Yes)
        {
            Status = LOCTEXT("OverwriteCancelled", "Export cancelled. Existing destination file and active project unchanged.");
            return FReply::Handled();
        }

        // Finish writing a separate file before attempting to replace a confirmed destination.
        const FString TemporaryPath = Destination + TEXT(".tmp-") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
        if (!FFileHelper::SaveStringToFile(Json, *TemporaryPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
        {
            IFileManager::Get().Delete(*TemporaryPath);
            ReportFailure(TEXT("Could not write the export file. Check destination permissions and free disk space."));
            return FReply::Handled();
        }
        if (!IFileManager::Get().Move(*Destination, *TemporaryPath, bDestinationExists))
        {
            IFileManager::Get().Delete(*TemporaryPath);
            ReportFailure(TEXT("Could not move the completed export to its destination. Check permissions or choose another path."));
            return FReply::Handled();
        }
        Status = FText::FromString(FString::Printf(
            TEXT("Validated project exported to %s. Project revision is unchanged."), *Destination));
        return FReply::Handled();
    }

    FReply SpawnLevelActors()
    {
        if (!HasProject())
        {
            return FReply::Handled();
        }

        UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
        if (!World)
        {
            ReportFailure(TEXT("No active editor level found to spawn actors."));
            return FReply::Handled();
        }

        int32 SpawnedCount = 0;
        int32 UpdatedCount = 0;

        UStaticMesh* BasicCubeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));

        for (const FRecordItem& Record : Records)
        {
            if (!Record.IsValid())
            {
                continue;
            }

            const FString Kind = Record->GetStringField(TEXT("kind"));
            if (Kind != TEXT("asset_instance"))
            {
                continue;
            }

            const FString Id = Record->GetStringField(TEXT("id"));
            const FString Label = Record->GetStringField(TEXT("label"));

            const TSharedPtr<FJsonObject>* TransformObj = nullptr;
            if (!Record->TryGetObjectField(TEXT("transform"), TransformObj) || !TransformObj || !(*TransformObj).IsValid())
            {
                continue;
            }

            const TArray<TSharedPtr<FJsonValue>>* PosArray = nullptr;
            const TArray<TSharedPtr<FJsonValue>>* RotArray = nullptr;
            if (!(*TransformObj)->TryGetArrayField(TEXT("position"), PosArray) ||
                !(*TransformObj)->TryGetArrayField(TEXT("rotation"), RotArray) ||
                !PosArray || !RotArray || PosArray->Num() != 3 || RotArray->Num() != 4)
            {
                continue;
            }

            SpatialPrevisCoordinates::Vector Pos{
                (*PosArray)[0]->AsNumber(),
                (*PosArray)[1]->AsNumber(),
                (*PosArray)[2]->AsNumber()
            };
            SpatialPrevisCoordinates::Quaternion Rot{
                (*RotArray)[0]->AsNumber(),
                (*RotArray)[1]->AsNumber(),
                (*RotArray)[2]->AsNumber(),
                (*RotArray)[3]->AsNumber()
            };

            const FTransform NativeTransform = SpatialPrevisTransform::ToNative(Pos, Rot);

            TArray<AActor*> FoundActors;
            UGameplayStatics::GetAllActorsWithTag(World, FName(*Id), FoundActors);
            if (FoundActors.Num() > 0)
            {
                AActor* ExistingActor = FoundActors[0];
                if (ExistingActor)
                {
                    ExistingActor->SetActorTransform(NativeTransform);
                    UpdatedCount++;
                }
            }
            else
            {
                FActorSpawnParameters SpawnParams;
                SpawnParams.Name = *FString::Printf(TEXT("SP_%s"), *Id);
                SpawnParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

                AActor* NewActor = World->SpawnActor<AActor>(AActor::StaticClass(), NativeTransform, SpawnParams);
                if (NewActor)
                {
                    NewActor->Tags.Add(FName(TEXT("SpatialPrevisActor")));
                    NewActor->Tags.Add(FName(*Id));
                    NewActor->SetActorLabel(FString::Printf(TEXT("%s (%s)"), *Label, *Id));

                    USceneComponent* RootComp = NewObject<USceneComponent>(NewActor, TEXT("RootComponent"));
                    NewActor->SetRootComponent(RootComp);
                    RootComp->RegisterComponent();
                    RootComp->SetWorldTransform(NativeTransform);

                    if (BasicCubeMesh)
                    {
                        UStaticMeshComponent* MeshComp = NewObject<UStaticMeshComponent>(NewActor, TEXT("VisualMesh"));
                        MeshComp->SetStaticMesh(BasicCubeMesh);
                        MeshComp->AttachToComponent(RootComp, FAttachmentTransformRules::KeepRelativeTransform);
                        MeshComp->SetRelativeScale3D(FVector(0.5f, 0.5f, 0.5f));
                        MeshComp->RegisterComponent();
                    }

                    SpawnedCount++;
                }
            }
        }

        Status = FText::FromString(FString::Printf(
            TEXT("Level sync complete: %d actors spawned, %d updated in active level."), SpawnedCount, UpdatedCount));
        return FReply::Handled();
    }

    FReply ClearLevelActors()
    {
        UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
        if (!World)
        {
            ReportFailure(TEXT("No active editor world found."));
            return FReply::Handled();
        }

        TArray<AActor*> FoundActors;
        UGameplayStatics::GetAllActorsWithTag(World, FName(TEXT("SpatialPrevisActor")), FoundActors);
        const int32 Count = FoundActors.Num();
        for (AActor* Actor : FoundActors)
        {
            if (Actor)
            {
                Actor->Destroy();
            }
        }

        Status = FText::FromString(FString::Printf(TEXT("Cleared %d Spatial Previs actors from active level."), Count));
        return FReply::Handled();
    }

    FReply LaunchStageShowcase()
    {
        const FString ShowcaseUrl = TEXT("http://localhost:5173/r0.html?showcase=true");
        FPlatformProcess::LaunchURL(*ShowcaseUrl, nullptr, nullptr);
        Status = LOCTEXT("ShowcaseLaunched", "Concert stage showcase opened in Production Workspace (http://localhost:5173/r0.html?showcase=true).");
        return FReply::Handled();
    }

    void RefreshSummary()
    {
        int32 UnknownQuantities = 0;
        int32 Ports = 0;
        int32 Connections = 0;
        int32 Attachments = 0;
        int32 Assemblies = 0;
        int32 Memberships = 0;
        int32 LockedRecords = 0;
        const auto CountUnknown = [&UnknownQuantities](const TSharedPtr<FJsonObject>& Quantity)
        {
            if (Quantity->GetStringField(TEXT("status")) == TEXT("unknown"))
            {
                ++UnknownQuantities;
            }
        };
        for (const FRecordItem& Record : Records)
        {
            const FString Kind = Record->GetStringField(TEXT("kind"));
            LockedRecords += Record->GetBoolField(TEXT("locked")) ? 1 : 0;
            if (Kind == TEXT("asset_definition"))
            {
                for (const auto& Entry : Record->GetObjectField(TEXT("specifications"))->Values)
                {
                    CountUnknown(Entry.Value->AsObject());
                }
            }
            else if (Kind == TEXT("surface"))
            {
                CountUnknown(Record->GetObjectField(TEXT("width")));
                CountUnknown(Record->GetObjectField(TEXT("height")));
            }
            else if (Kind == TEXT("port")) { ++Ports; }
            else if (Kind == TEXT("connection")) { ++Connections; }
            else if (Kind == TEXT("mechanical_attachment")) { ++Attachments; }
            else if (Kind == TEXT("assembly"))
            {
                ++Assemblies;
                Memberships += Record->GetArrayField(TEXT("instanceIds")).Num();
            }
        }
        Summary = FText::FromString(FString::Printf(
            TEXT("Project: %s | Schema: %.0f | Revision: %.0f | Records: %d | Locked: %d\n")
            TEXT("Unknown quantities: %d | Ports: %d | Connections: %d | Mechanical attachments: %d | Assemblies: %d (%d memberships)\n")
            TEXT("Coordinate frame: right_handed_y_up_meters (stored contract; no native scene conversion in this milestone)"),
            *ActiveProject->GetStringField(TEXT("projectId")),
            ActiveProject->GetNumberField(TEXT("schemaVersion")), ActiveProject->GetNumberField(TEXT("revision")),
            Records.Num(), LockedRecords, UnknownQuantities, Ports, Connections, Attachments, Assemblies, Memberships));
    }
};
}

class FSpatialPrevisEditorModule : public IModuleInterface
{
public:
    virtual void StartupModule() override
    {
        // Commandlets use the codec without requiring an initialized Slate application.
        if (IsRunningCommandlet())
        {
            return;
        }
        FGlobalTabmanager::Get()->RegisterNomadTabSpawner(SpatialPrevisEditor::TabName,
            FOnSpawnTab::CreateRaw(this, &FSpatialPrevisEditorModule::SpawnTab))
            .SetDisplayName(LOCTEXT("TabTitle", "Spatial Previs R0"))
            .SetTooltipText(LOCTEXT("TabTooltip", "Inspect and export a validated production project."))
            .SetMenuType(ETabSpawnerMenuType::Hidden);
        bTabRegistered = true;
        UToolMenus::RegisterStartupCallback(
            FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FSpatialPrevisEditorModule::RegisterMenus));
    }

    virtual void ShutdownModule() override
    {
        UToolMenus::UnRegisterStartupCallback(this);
        UToolMenus::UnregisterOwner(this);
        if (bTabRegistered && FSlateApplication::IsInitialized())
        {
            if (TSharedPtr<SDockTab> Tab = FGlobalTabmanager::Get()->FindExistingLiveTab(SpatialPrevisEditor::TabName))
            {
                Tab->RequestCloseTab();
            }
            FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(SpatialPrevisEditor::TabName);
        }
    }

private:
    bool bTabRegistered = false;

    void RegisterMenus()
    {
        FToolMenuOwnerScoped Owner(this);
        UToolMenu* ToolsMenu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Tools"));
        FToolMenuSection& Section = ToolsMenu->FindOrAddSection(TEXT("SpatialPrevis"));
        Section.AddMenuEntry(TEXT("OpenSpatialPrevisR0"),
            LOCTEXT("OpenMenu", "Spatial Previs R0"),
            LOCTEXT("OpenMenuTooltip", "Open CORE-01 production project inspection."),
            FSlateIcon(), FUIAction(FExecuteAction::CreateRaw(this, &FSpatialPrevisEditorModule::OpenTab)));
        Section.AddMenuEntry(TEXT("LaunchStageShowcase"),
            LOCTEXT("LaunchShowcaseMenu", "Launch Concert Stage Showcase"),
            LOCTEXT("LaunchShowcaseMenuTooltip", "Open the concert stage showcase in your default desktop browser."),
            FSlateIcon(), FUIAction(FExecuteAction::CreateLambda([]()
            {
                FPlatformProcess::LaunchURL(TEXT("http://localhost:5173/r0.html?showcase=true"), nullptr, nullptr);
            })));
    }

    void OpenTab()
    {
        FGlobalTabmanager::Get()->TryInvokeTab(SpatialPrevisEditor::TabName);
    }

    TSharedRef<SDockTab> SpawnTab(const FSpawnTabArgs&)
    {
        return SNew(SDockTab)
            .TabRole(ETabRole::NomadTab)
            [
                SNew(SpatialPrevisEditor::SProjectInspectionPanel)
            ];
    }
};

IMPLEMENT_MODULE(FSpatialPrevisEditorModule, SpatialPrevisEditor)

#undef LOCTEXT_NAMESPACE
