using UnrealBuildTool;

public class SpatialPrevisEditor : ModuleRules
{
    public SpatialPrevisEditor(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        bUseUnity = false;
        PrivateDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "SpatialPrevisCore", "Json", "UnrealEd",
            "Slate", "SlateCore", "InputCore", "ToolMenus", "DesktopPlatform"
        });
    }
}
