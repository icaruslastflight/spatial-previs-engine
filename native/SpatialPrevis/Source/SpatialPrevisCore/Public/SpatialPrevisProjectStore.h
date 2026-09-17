#pragma once

#include "CoreMinimal.h"

class FJsonObject;
class FJsonValue;

/** Host identity, never deserialized from a transaction or imported workspace. */
struct SPATIALPREVISCORE_API FSpatialPrevisPrincipal
{
    FString Id;
    bool bHuman = false;
};

/**
 * One authoritative workspace; mirrors ProjectStore.ts. Call on one host thread.
 * All returned objects are detached. Failed requests do not mutate committed state.
 * A local editor should authorize edit/unlock only, never specialist review/issue.
 */
class SPATIALPREVISCORE_API FSpatialPrevisProjectStore
{
public:
    using FAuthorizer = TFunction<bool(const FSpatialPrevisPrincipal&, const FString&, const TArray<FString>&)>;

    bool Initialize(const TSharedPtr<FJsonObject>& WorkspaceOrProject, FAuthorizer Authorizer, FString& OutError);
    TSharedPtr<FJsonObject> GetWorkspace() const;
    TSharedPtr<FJsonObject> GetProject() const;

    bool Execute(const TSharedPtr<FJsonObject>& Transaction, const FSpatialPrevisPrincipal& Principal,
        TSharedPtr<FJsonObject>& OutChange, FString& OutError);
    bool Preview(const TSharedPtr<FJsonObject>& Transaction, const FSpatialPrevisPrincipal& Principal,
        TSharedPtr<FJsonObject>& OutPreview, FString& OutError);
    void Cancel(const FString& PreviewId);
    bool Accept(const FString& PreviewId, const FSpatialPrevisPrincipal& Principal,
        TSharedPtr<FJsonObject>& OutChange, FString& OutError);
    bool Undo(const FString& Key, double BaseRevision, const FSpatialPrevisPrincipal& Principal,
        TSharedPtr<FJsonObject>& OutChange, FString& OutError);
    bool Redo(const FString& Key, double BaseRevision, const FSpatialPrevisPrincipal& Principal,
        TSharedPtr<FJsonObject>& OutChange, FString& OutError);

    /** BaseRevision belongs to the start of the calculation, not its completion. */
    bool RecordCheck(const TSharedPtr<FJsonObject>& Result, double BaseRevision,
        TSharedPtr<FJsonObject>& OutCheck, FString& OutError);
    bool Review(const FString& CheckId, const FString& ReviewId, const TArray<FString>& Evidence,
        const FSpatialPrevisPrincipal& Principal, TSharedPtr<FJsonObject>& OutReview, FString& OutError);
    bool Review(const FString& CheckId, const FString& ReviewId, const TArray<FString>& Evidence,
        const FSpatialPrevisPrincipal& Principal, TSharedPtr<FJsonObject>& OutReview, FString& OutError,
        const FString& Now);
    bool Issue(const FString& Id, const TArray<FString>& RequiredCheckIds, const FSpatialPrevisPrincipal& Principal,
        TSharedPtr<FJsonObject>& OutArtifact, FString& OutError);
    bool Issue(const FString& Id, const TArray<FString>& RequiredCheckIds, const FSpatialPrevisPrincipal& Principal,
        TSharedPtr<FJsonObject>& OutArtifact, FString& OutError, const FString& Now);

    static bool DeleteInstanceOperations(const TSharedPtr<FJsonObject>& Project, const FString& InstanceId,
        TArray<TSharedPtr<FJsonValue>>& OutOperations, FString& OutError);
    static bool TranslateInstanceOperations(const TSharedPtr<FJsonObject>& Project, const FString& InstanceId,
        const FVector3d& PositionMetres, TArray<TSharedPtr<FJsonValue>>& OutOperations, FString& OutError);
    static bool TechnicalDataCheck(const TSharedPtr<FJsonObject>& Project, const TSharedPtr<FJsonObject>& Record,
        const FString& Id, TSharedPtr<FJsonObject>& OutResult, FString& OutError);

private:
    TSharedPtr<FJsonObject> State;
    FAuthorizer Authorize;
    TMap<FString, TSharedPtr<FJsonObject>> Previews;
    uint64 PreviewCounter = 0;

    bool Permit(const FSpatialPrevisPrincipal& Principal, const FString& Action, const TArray<FString>& Scope, FString& OutError) const;
    bool Request(const TSharedPtr<FJsonObject>& Transaction, FString& OutError) const;
    bool Stage(const TSharedPtr<FJsonObject>& Transaction, const FSpatialPrevisPrincipal& Principal,
        TSharedPtr<FJsonObject>& OutProject, FString& OutError) const;
    bool Apply(const TSharedPtr<FJsonObject>& Transaction, const FSpatialPrevisPrincipal& Principal,
        TSharedPtr<FJsonObject>& OutChange, FString& OutError);
    bool Travel(const FString& Direction, const FString& Key, double BaseRevision, const FSpatialPrevisPrincipal& Principal,
        TSharedPtr<FJsonObject>& OutChange, FString& OutError);
    bool Commit(const TSharedPtr<FJsonObject>& CandidateState, const TArray<TSharedPtr<FJsonValue>>& Records,
        const FString& Label, TSharedPtr<FJsonObject>& OutChange, FString& OutError);
    bool UniqueId(const FString& Id, FString& OutError) const;
};
