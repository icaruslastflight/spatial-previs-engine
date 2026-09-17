#pragma once

// Kept independent of Unreal types so the exact boundary used in the native adapter
// can also be compiled and verified before an engine installation is available.
namespace SpatialPrevisCoordinates
{
struct Vector { double X, Y, Z; };
struct Quaternion { double X, Y, Z, W; };

// Project: right-handed X=east, Y=up, Z=-north, metres.
// Native: left-handed X=north, Y=east, Z=up, centimetres.
inline Vector ToNativePosition(const Vector& P) { return {-100.0 * P.Z, 100.0 * P.X, 100.0 * P.Y}; }
inline Vector ToProjectPosition(const Vector& P) { return {P.Y / 100.0, P.Z / 100.0, -P.X / 100.0}; }
inline Vector ToNativeDirection(const Vector& V) { return {-V.Z, V.X, V.Y}; }
inline Vector ToProjectDirection(const Vector& V) { return {V.Y, V.Z, -V.X}; }

// det(M)=-1: quaternion vector part transforms by -M. A component copy would
// mirror rotation incorrectly. R_native = M R_project M^-1, including mixed axes.
inline Quaternion ToNativeRotation(const Quaternion& Q) { return {Q.Z, -Q.X, -Q.Y, Q.W}; }
inline Quaternion ToProjectRotation(const Quaternion& Q) { return {-Q.Y, -Q.Z, Q.X, Q.W}; }
}
