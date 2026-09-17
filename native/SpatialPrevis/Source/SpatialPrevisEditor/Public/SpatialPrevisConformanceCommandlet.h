#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "SpatialPrevisConformanceCommandlet.generated.h"

UCLASS()
class USpatialPrevisConformanceCommandlet : public UCommandlet
{
    GENERATED_BODY()
public:
    USpatialPrevisConformanceCommandlet();
    virtual int32 Main(const FString& Params) override;
};
