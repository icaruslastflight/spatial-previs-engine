#pragma once

#include "CoreMinimal.h"

class FJsonObject;

/** R0 desktop workspace repository. Windows storage uses one locked manifest.
 * A failed operation leaves caller outputs unchanged. Import is storage independent.
 */
class SPATIALPREVISCORE_API FSpatialPrevisWorkspaceRepository
{
public:
	/** Expected generation for a project which has not been saved in this repository. */
	static constexpr int64 NewProjectGeneration = -1;
	explicit FSpatialPrevisWorkspaceRepository(const FString& InRootDirectory);

	/** Strict parse/migration; rehash checks; every imported review requires fresh authorization.
	 * Issued content strings remain byte-for-byte unchanged through JSON decoding/encoding.
	 */
	static bool Import(const FString& Json, TSharedPtr<FJsonObject>& OutState, FString& OutError);

	/** Missing project is successful: null OutState and NewProjectGeneration. */
	bool Load(const FString& ProjectId, TSharedPtr<FJsonObject>& OutState,
		int64& OutGeneration, FString& OutError) const;
	/** Empty OutId on success means no active project has been saved. */
	bool LastProjectId(FString& OutId, FString& OutError) const;
	/** Commit state and active project ID together, only if the stored generation matches.
	 * Conflict/write failure preserves unsaved caller state. Save does not revoke current reviews.
	 */
	bool Save(const TSharedPtr<FJsonObject>& State, int64 ExpectedGeneration,
		int64& OutNextGeneration, FString& OutError) const;

	const FString& GetRootDirectory() const { return RootDirectory; }
	FString GetManifestPath() const;

private:
	FString RootDirectory;
};
