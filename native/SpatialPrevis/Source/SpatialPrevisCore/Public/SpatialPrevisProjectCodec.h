#pragma once

#include "CoreMinimal.h"

class FJsonObject;

/**
 * Experimental project-v1 codec; mirrors src/domain/ProjectCodec.ts.
 * Validates the entire graph without migrations, scene changes or approval effects.
 * Retains JSON values, record ordering, unknown quantities and separate edge kinds.
 * Parse/Serialize replace their result only on success; OutError describes failure
 * and is cleared on success. Serialization is semantic JSON, not issued-byte storage.
 */
class SPATIALPREVISCORE_API FSpatialPrevisProjectCodec
{
public:
    static bool Parse(const FString& Json, TSharedPtr<FJsonObject>& OutProject, FString& OutError);
    static bool Validate(const TSharedPtr<FJsonObject>& Project, FString& OutError);
    static bool Serialize(const TSharedPtr<FJsonObject>& Project, FString& OutJson, FString& OutError);
};
