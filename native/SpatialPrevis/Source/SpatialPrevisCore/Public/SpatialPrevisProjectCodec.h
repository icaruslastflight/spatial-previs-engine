#pragma once

#include "CoreMinimal.h"

class FJsonObject;
class FJsonValue;

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

    // Case-sensitive round-trip variants. Unreal's TMap<FString> underneath
    // FJsonObject::Values hashes and compares FString case-insensitively, so
    // objects whose keys differ only in case (e.g. specifications "mass"/"Mass"
    // /"MASS") collapse silently on Deserialize. ParseWithExtras additionally
    // captures the raw JSON substring of each records[N].specifications value,
    // keyed by that record's exact-case id string. SerializeWithExtras emits
    // those preserved substrings verbatim in place of walking the deduped map,
    // so the shared conformance corpus round-trips faithfully.
    static bool ParseWithExtras(
        const FString& Json,
        TSharedPtr<FJsonObject>& OutProject,
        TArray<TPair<FString, FString>>& OutSpecificationsByRecordId,
        FString& OutError);
    static bool SerializeWithExtras(
        const TSharedPtr<FJsonObject>& Project,
        const TArray<TPair<FString, FString>>& SpecificationsByRecordId,
        FString& OutJson,
        FString& OutError);

    /** Generic strict JSON boundary for envelopes. These helpers do not validate a project schema. */
    static bool ParseJson(const FString& Json, TSharedPtr<FJsonValue>& OutValue, FString& OutError);
    static bool SerializeJson(const TSharedPtr<FJsonValue>& Value, FString& OutJson, FString& OutError);
};
