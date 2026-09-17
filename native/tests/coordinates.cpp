#include "SpatialPrevisCoordinates.h"
#include <cmath>
#include <iostream>
#include <stdexcept>

namespace SC = SpatialPrevisCoordinates;
static int Assertions = 0;
static void Near(double Actual, double Expected)
{
    ++Assertions;
    if (!std::isfinite(Actual) || std::abs(Actual - Expected) > 1e-10)
        throw std::runtime_error("Coordinate boundary assertion failed");
}
static void Equal(SC::Vector A, SC::Vector B) { Near(A.X,B.X); Near(A.Y,B.Y); Near(A.Z,B.Z); }
static SC::Vector Rotate(SC::Quaternion Q, SC::Vector V)
{
    // Independent quaternion rotation matrix; not a second copy of the basis map.
    const double X=Q.X, Y=Q.Y, Z=Q.Z, W=Q.W;
    return {
        (1-2*(Y*Y+Z*Z))*V.X + 2*(X*Y-Z*W)*V.Y + 2*(X*Z+Y*W)*V.Z,
        2*(X*Y+Z*W)*V.X + (1-2*(X*X+Z*Z))*V.Y + 2*(Y*Z-X*W)*V.Z,
        2*(X*Z-Y*W)*V.X + 2*(Y*Z+X*W)*V.Y + (1-2*(X*X+Y*Y))*V.Z
    };
}
int main()
{
    Equal(SC::ToNativePosition({1,0,0}), {0,100,0});
    Equal(SC::ToNativePosition({0,1,0}), {0,0,100});
    Equal(SC::ToNativePosition({0,0,1}), {-100,0,0});
    Equal(SC::ToNativePosition({1,2,3}), {-300,100,200});
    Equal(SC::ToProjectPosition({-300,100,200}), {1,2,3});
    const double H=std::sqrt(0.5), N=std::sqrt(30.0);
    const SC::Quaternion Rotations[] = {
        {0,0,0,1}, {H,0,0,H}, {0,H,0,H}, {0,0,H,H},
        {1/N,2/N,3/N,4/N}, {-1/N,-2/N,-3/N,-4/N}, {1,0,0,0}
    };
    const SC::Vector Vectors[] = {{1,0,0},{0,1,0},{0,0,1},{-2,3.5,4},{0,0,0}};
    for (auto Q : Rotations)
    {
        auto Native=SC::ToNativeRotation(Q), Back=SC::ToProjectRotation(Native);
        Near(Back.X,Q.X); Near(Back.Y,Q.Y); Near(Back.Z,Q.Z); Near(Back.W,Q.W);
        for (auto V : Vectors)
        {
            Equal(Rotate(Native, SC::ToNativeDirection(V)), SC::ToNativeDirection(Rotate(Q,V)));
            Equal(SC::ToProjectPosition(SC::ToNativePosition(V)), V);
            Equal(SC::ToProjectDirection(SC::ToNativeDirection(V)), V);
        }
    }
    std::cout << "PASS " << Assertions << " coordinate assertions; native engine execution remains separate\n";
}
