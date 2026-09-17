#pragma once

#include "CoreMinimal.h"

class FJsonObject;
class FJsonValue;

/** Experimental WorkspaceState.ts boundary. Data outputs change only on success. */
class SPATIALPREVISCORE_API FSpatialPrevisWorkspaceCodec
{
public:
    static bool Parse(const FString& Json, TSharedPtr<FJsonObject>& OutWorkspace, FString& OutError);
    static bool Validate(const TSharedPtr<FJsonObject>& Workspace, FString& OutError);
    static bool Serialize(const TSharedPtr<FJsonObject>& Workspace, FString& OutJson, FString& OutError);
    static bool FromProject(const TSharedPtr<FJsonObject>& Project, TSharedPtr<FJsonObject>& OutWorkspace, FString& OutError);

    /** Detached recursive copy. Null input returns null. The input must be JSON-only and acyclic. */
    static TSharedPtr<FJsonObject> Clone(const TSharedPtr<FJsonObject>& Object);
    /** JavaScript canonical JSON: UTF-16 sorted keys, ordered arrays, shortest double numbers. Input must be acyclic JSON. */
    static FString Canonical(const TSharedPtr<FJsonValue>& Value);
    /** Dependency helpers operate on ProjectCodec-validated records/projects, retaining record references. */
    static TArray<FString> References(const TSharedPtr<FJsonObject>& Record);
    static TArray<TSharedPtr<FJsonValue>> ScopedInputs(const TSharedPtr<FJsonObject>& Project, const TArray<FString>& Scope);
    static bool InputHash(const TSharedPtr<FJsonObject>& Project, const TArray<FString>& Scope,
        const FString& Model, const FString& ModelVersion, FString& OutHash, FString& OutError);
};
