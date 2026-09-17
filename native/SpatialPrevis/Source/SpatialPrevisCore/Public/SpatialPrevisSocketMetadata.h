#pragma once

#include "CoreMinimal.h"

class FJsonObject;

/** Shared constants mirror SocketSnappingEngine.ts. All distances are metres. */
namespace SpatialPrevisSocketDefaults
{
	inline constexpr double SnapRadius = 0.15;
	inline constexpr double SnapAngleRadians = (15.0 * 3.14159265358979323846) / 180.0;
	inline constexpr double DetentStepRadians = 3.14159265358979323846 / 2.0;
	inline constexpr double DirectionEpsilon = 1e-6;
}

/** Socket lifted into the asset wrapper's shared right-handed Y-up metre frame. */
struct SPATIALPREVISCORE_API FSpatialPrevisSocket
{
	FString Id;
	FString Type;
	FString Gender;
	FVector3d Position = FVector3d::ZeroVector;
	FVector3d Normal = FVector3d::ZeroVector;
	FVector3d Up = FVector3d::ZeroVector;
	double SnapRadius = SpatialPrevisSocketDefaults::SnapRadius;
	double SnapAngleRadians = SpatialPrevisSocketDefaults::SnapAngleRadians;
	double DetentStepRadians = SpatialPrevisSocketDefaults::DetentStepRadians;
	bool bCanParent = true;
	bool bCanChild = true;
	bool bLoadBearing = false;
	TOptional<double> MaxLoadKg;
	TArray<FString> Tags;
};

/** Metadata-only local GLB 2 / glTF 2 reader. Does not fetch buffers, meshes or URLs.
 * On failure all data outputs retain their previous values.
 */
class SPATIALPREVISCORE_API FSpatialPrevisSocketMetadata
{
public:
	/** AssetRoot is the public directory; ModelUri is a relative model path beneath it. */
	static bool Load(const FString& ModelUri, const FString& AssetRoot,
		TArray<FSpatialPrevisSocket>& OutSockets, FString& OutError);
	/** Parse a glTF JSON document and lift its default scene's sockets in traversal order. */
	static bool ParseGltf(const FString& Json, TArray<FSpatialPrevisSocket>& OutSockets, FString& OutError);
	/** SocketSnappingEngine.normalizeSocket boundary; no node transform is applied here. */
	static bool Normalize(const TSharedPtr<FJsonObject>& Raw, FSpatialPrevisSocket& OutSocket, FString& OutError);
};
