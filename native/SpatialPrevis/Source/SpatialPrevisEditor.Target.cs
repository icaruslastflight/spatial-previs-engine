using UnrealBuildTool;
using System.Collections.Generic;

public class SpatialPrevisEditorTarget : TargetRules
{
    public SpatialPrevisEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        ExtraModuleNames.AddRange(new string[] { "SpatialPrevisCore", "SpatialPrevisEditor" });
    }
}
