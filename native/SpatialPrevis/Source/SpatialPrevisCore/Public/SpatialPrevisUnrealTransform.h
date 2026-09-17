#pragma once

#include "CoreMinimal.h"
#include "SpatialPrevisCoordinates.h"

namespace SpatialPrevisTransform
{
inline FTransform ToNative(const SpatialPrevisCoordinates::Vector& Position,
    const SpatialPrevisCoordinates::Quaternion& Rotation)
{
    const auto P = SpatialPrevisCoordinates::ToNativePosition(Position);
    const auto Q = SpatialPrevisCoordinates::ToNativeRotation(Rotation);
    return FTransform(FQuat(Q.X, Q.Y, Q.Z, Q.W), FVector(P.X, P.Y, P.Z), FVector::OneVector);
}
// Export source JSON unchanged when it has not been edited; do not run it through
// FTransform just to save it, which could introduce rounding or quaternion sign changes.
}
