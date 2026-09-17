#pragma once

#include "CoreMinimal.h"

class FJsonObject;
class FJsonValue;

/** Detached JSON-only scene evidence. No network, provider, authority, or write capability.
 * Inputs must be acyclic JSON values. OutResult changes only on success.
 */
class SPATIALPREVISCORE_API FSpatialPrevisSceneTools
{
public:
    static bool Read(const TSharedPtr<FJsonObject>& Workspace,
        const TSharedPtr<FJsonValue>& Request, TSharedPtr<FJsonObject>& OutResult, FString& Error);
};
