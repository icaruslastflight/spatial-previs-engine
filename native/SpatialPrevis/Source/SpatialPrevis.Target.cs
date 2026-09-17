using UnrealBuildTool;
using System.Collections.Generic;

public class SpatialPrevisTarget : TargetRules
{
    public SpatialPrevisTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        ExtraModuleNames.Add("SpatialPrevisCore");
    }
}
