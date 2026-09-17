using UnrealBuildTool;

public class SpatialPrevisEditor : ModuleRules
{
    public SpatialPrevisEditor(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "SpatialPrevisCore", "Json", "UnrealEd",
            "Slate", "SlateCore", "InputCore", "ToolMenus", "DesktopPlatform"
        });
    }
}
