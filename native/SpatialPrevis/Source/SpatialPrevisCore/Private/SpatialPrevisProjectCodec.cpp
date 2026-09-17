#include "SpatialPrevisProjectCodec.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/Crc.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include <charconv>
#include <cmath>
#include <initializer_list>
#include <limits>
#include <system_error>

namespace
{
using FObject = TSharedPtr<FJsonObject>;
using FValue = TSharedPtr<FJsonValue>;
using FValues = TArray<FValue>;

// JSON/JavaScript identifiers are exact code-unit strings, never FNames. Length
// plus byte comparison also preserves embedded escaped NULs in identifiers.
bool Same(const FString& A, const FString& B)
{
    return A.Len() == B.Len() &&
        (A.IsEmpty() || FMemory::Memcmp(*A, *B, A.Len() * sizeof(TCHAR)) == 0);
}

struct FExactString
{
    FString Value;
    FExactString() = default;
    FExactString(const FString& InValue) : Value(InValue) {}
    bool operator==(const FExactString& Other) const { return Same(Value, Other.Value); }
    friend uint32 GetTypeHash(const FExactString& Key)
    {
        return FCrc::MemCrc32(*Key.Value, Key.Value.Len() * sizeof(TCHAR));
    }
};

FValue Field(const FObject& Object, const TCHAR* Name)
{
    // Iteration avoids coercing field names and works with both FString and the
    // shared-string JSON object keys introduced by newer UE versions.
    const FString Expected(Name);
    for (const auto& Entry : Object->Values)
    {
        if (Same(FString(Entry.Key.Len(), *Entry.Key), Expected)) return Entry.Value;
    }
    return nullptr;
}

bool HasType(const FValue& Value, EJson Type)
{
    return Value.IsValid() && Value->Type == Type;
}

// The following accessors are called only after the corresponding shape passed
// validation. No As* fallback value is ever used to validate an untyped field.
FString String(const FObject& Object, const TCHAR* Name) { return Field(Object, Name)->AsString(); }
double Number(const FObject& Object, const TCHAR* Name) { return Field(Object, Name)->AsNumber(); }

bool IsTrimWhitespace(TCHAR Character)
{
    const uint32 C = static_cast<uint32>(Character);
    // ECMAScript String.trim, including BOM, but excluding NEL and U+180E.
    return (C >= 0x09 && C <= 0x0d) || C == 0x20 || C == 0xa0 || C == 0x1680 ||
        (C >= 0x2000 && C <= 0x200a) || C == 0x2028 || C == 0x2029 ||
        C == 0x202f || C == 0x205f || C == 0x3000 || C == 0xfeff;
}

bool HasNonWhitespace(const FString& Value)
{
    for (int32 I = 0; I < Value.Len(); ++I) if (!IsTrimWhitespace(Value[I])) return true;
    return false;
}

class FValidator
{
public:
    explicit FValidator(FString& InError) : Error(InError) {}

    bool Project(const FObject& P)
    {
        if (!P.IsValid()) return Fail(TEXT("project"), TEXT("expected object"));
        const FValue Version = Field(P, TEXT("schemaVersion"));
        if (!HasType(Version, EJson::Number) || Version->AsNumber() != 1.0)
            return Fail(TEXT("project.schemaVersion"), TEXT("unsupported version; migration required"));
        if (!Keys(P, {TEXT("schemaVersion"), TEXT("projectId"), TEXT("revision"), TEXT("coordinateFrame"), TEXT("records")}, TEXT("project")) ||
            !Text(Field(P, TEXT("projectId")), TEXT("project.projectId")) ||
            !Natural(Field(P, TEXT("revision")), TEXT("project.revision")) ||
            !OneOf(Field(P, TEXT("coordinateFrame")), {TEXT("right_handed_y_up_meters")}, TEXT("project.coordinateFrame"))) return false;
        const FValue RecordsValue = Field(P, TEXT("records"));
        if (!HasType(RecordsValue, EJson::Array)) return Fail(TEXT("project.records"), TEXT("expected array"));
        const FValues& Records = RecordsValue->AsArray();
        for (int32 I = 0; I < Records.Num(); ++I)
            if (!Record(Records[I], FString::Printf(TEXT("project.records[%d]"), I))) return false;

        TMap<FExactString, FObject> ById;
        for (const FValue& Value : Records)
        {
            const FObject& R = Value->AsObject();
            const FString Id = String(R, TEXT("id"));
            if (ById.Contains(FExactString(Id))) return Fail(Id, TEXT("duplicate record ID"));
            ById.Add(FExactString(Id), R);
        }
        auto Reference = [&](const FString& Id, const TCHAR* Kind, const FString& Path, FObject& Out) -> bool
        {
            const FObject* Target = ById.Find(FExactString(Id));
            if (!Target || !Same(String(*Target, TEXT("kind")), Kind))
                return Fail(Path, FString::Printf(TEXT("expected %s reference: %s"), Kind, *Id));
            Out = *Target;
            return true;
        };
        TSet<FExactString> AllocatedItems;
        TMap<FExactString, FExactString> ParentOf;
        // Separate instance and socket keys avoid ambiguous concatenated IDs.
        TMap<FExactString, TSet<FExactString>> Sockets;
        for (const FValue& Value : Records)
        {
            const FObject& R = Value->AsObject();
            const FString Id = String(R, TEXT("id"));
            const FString Kind = String(R, TEXT("kind"));
            FObject Target;
            if (Field(R, TEXT("definitionId")).IsValid() &&
                !Reference(String(R, TEXT("definitionId")), TEXT("asset_definition"), Id, Target)) return false;
            if (Same(Kind, TEXT("asset_instance")) && !HasType(Field(R, TEXT("inventoryItemId")), EJson::Null))
            {
                if (!Reference(String(R, TEXT("inventoryItemId")), TEXT("inventory_item"), Id, Target)) return false;
                if (!Same(String(Target, TEXT("definitionId")), String(R, TEXT("definitionId"))))
                    return Fail(Id, TEXT("inventory definition mismatch"));
                const FExactString ItemId(String(Target, TEXT("id")));
                if (AllocatedItems.Contains(ItemId)) return Fail(Id, TEXT("inventory item already allocated"));
                AllocatedItems.Add(ItemId);
            }
            if (Same(Kind, TEXT("assembly")))
                for (const FValue& Instance : Field(R, TEXT("instanceIds"))->AsArray())
                    if (!Reference(Instance->AsString(), TEXT("asset_instance"), Id, Target)) return false;
            if (Same(Kind, TEXT("port")) &&
                !Reference(String(R, TEXT("instanceId")), TEXT("asset_instance"), Id, Target)) return false;
            if (Same(Kind, TEXT("connection")))
            {
                FObject From, To;
                if (!Reference(String(R, TEXT("sourcePortId")), TEXT("port"), Id, From) ||
                    !Reference(String(R, TEXT("targetPortId")), TEXT("port"), Id, To)) return false;
                if (Same(String(From, TEXT("id")), String(To, TEXT("id")))) return Fail(Id, TEXT("cannot connect a port to itself"));
                if (!Same(String(From, TEXT("domain")), String(R, TEXT("domain"))) ||
                    !Same(String(To, TEXT("domain")), String(R, TEXT("domain")))) return Fail(Id, TEXT("connection domain mismatch"));
                if (Same(String(From, TEXT("direction")), TEXT("input")) || Same(String(To, TEXT("direction")), TEXT("output")))
                    return Fail(Id, TEXT("connection direction mismatch"));
                // Unknown protocols remain unknown; matching domains do not approve compatibility.
                if (!HasType(Field(From, TEXT("protocol")), EJson::Null) && !HasType(Field(To, TEXT("protocol")), EJson::Null) &&
                    !Same(String(From, TEXT("protocol")), String(To, TEXT("protocol")))) return Fail(Id, TEXT("protocol mismatch"));
            }
            if (Same(Kind, TEXT("mechanical_attachment")))
            {
                const FString Parent = String(R, TEXT("parentInstanceId"));
                const FString Child = String(R, TEXT("childInstanceId"));
                if (!Reference(Parent, TEXT("asset_instance"), Id, Target) ||
                    !Reference(Child, TEXT("asset_instance"), Id, Target)) return false;
                if (ParentOf.Contains(FExactString(Child))) return Fail(Id, TEXT("child already attached"));
                ParentOf.Add(FExactString(Child), FExactString(Parent));
                auto Occupy = [&](const FString& Instance, const FString& Socket) -> bool
                {
                    TSet<FExactString>& Occupied = Sockets.FindOrAdd(FExactString(Instance));
                    if (Occupied.Contains(FExactString(Socket))) return Fail(Id, TEXT("socket already occupied"));
                    Occupied.Add(FExactString(Socket));
                    return true;
                };
                if (!Occupy(Parent, String(R, TEXT("parentSocketId"))) || !Occupy(Child, String(R, TEXT("childSocketId")))) return false;
            }
            if (Same(Kind, TEXT("document_snapshot")) && Number(R, TEXT("projectRevision")) > Number(P, TEXT("revision")))
                return Fail(Id, TEXT("snapshot references a future revision"));
            // Snapshot membership belongs to its historical revision; deleted IDs are valid.
        }
        for (const auto& Entry : ParentOf)
        {
            TSet<FExactString> Seen;
            FExactString Id = Entry.Key;
            while (true)
            {
                if (Seen.Contains(Id)) return Fail(Entry.Key.Value, TEXT("mechanical attachment cycle"));
                Seen.Add(Id);
                const FExactString* Parent = ParentOf.Find(Id);
                if (!Parent) break;
                Id = *Parent;
            }
        }
        return true;
    }

private:
    FString& Error;

    bool Fail(const FString& Path, const FString& Message)
    {
        Error = Path + TEXT(": ") + Message;
        return false;
    }

    bool Object(const FValue& Value, const FString& Path, FObject& Out)
    {
        if (!HasType(Value, EJson::Object) || !Value->AsObject().IsValid()) return Fail(Path, TEXT("expected object"));
        Out = Value->AsObject();
        return true;
    }

    bool Keys(const FObject& Value, const TArray<FString>& Fields, const FString& Path)
    {
        for (const auto& Entry : Value->Values)
        {
            const FString Key(Entry.Key.Len(), *Entry.Key);
            if (!Fields.ContainsByPredicate([&](const FString& Expected) { return Same(Key, Expected); }))
                return Fail(Path + TEXT(".") + Key, TEXT("unsupported field"));
        }
        for (const FString& Key : Fields)
        {
            bool bFound = false;
            for (const auto& Entry : Value->Values)
                if (Same(FString(Entry.Key.Len(), *Entry.Key), Key)) { bFound = true; break; }
            if (!bFound) return Fail(Path + TEXT(".") + Key, TEXT("missing field"));
        }
        return true;
    }

    bool Text(const FValue& Value, const FString& Path)
    {
        return (HasType(Value, EJson::String) && HasNonWhitespace(Value->AsString())) || Fail(Path, TEXT("expected nonempty string"));
    }

    bool OneOf(const FValue& Value, std::initializer_list<const TCHAR*> Options, const FString& Path)
    {
        if (HasType(Value, EJson::String))
            for (const TCHAR* Option : Options) if (Same(Value->AsString(), Option)) return true;
        FString Message(TEXT("expected one of "));
        for (const TCHAR* Option : Options)
        {
            if (Message.Len() > 16) Message += TEXT(", ");
            Message += Option;
        }
        return Fail(Path, Message);
    }

    bool Natural(const FValue& Value, const FString& Path)
    {
        if (HasType(Value, EJson::Number))
        {
            const double N = Value->AsNumber();
            if (std::isfinite(N) && N >= 0.0 && N <= 9007199254740991.0 && std::floor(N) == N) return true;
        }
        return Fail(Path, TEXT("expected nonnegative safe integer"));
    }

    bool Tuple(const FValue& Value, int32 Length, const FString& Path)
    {
        if (HasType(Value, EJson::Array) && Value->AsArray().Num() == Length)
        {
            bool bValid = true;
            for (const FValue& Element : Value->AsArray())
                if (!HasType(Element, EJson::Number) || !std::isfinite(Element->AsNumber())) { bValid = false; break; }
            if (bValid) return true;
        }
        return Fail(Path, FString::Printf(TEXT("expected %d finite numbers"), Length));
    }

    bool Strings(const FValue& Value, const FString& Path)
    {
        if (!HasType(Value, EJson::Array)) return Fail(Path, TEXT("expected array"));
        const FValues& Array = Value->AsArray();
        for (int32 I = 0; I < Array.Num(); ++I)
            if (!Text(Array[I], FString::Printf(TEXT("%s[%d]"), *Path, I))) return false;
        TSet<FExactString> Seen;
        for (const FValue& Element : Array)
        {
            const FExactString Id(Element->AsString());
            if (Seen.Contains(Id)) return Fail(Path, TEXT("duplicate reference"));
            Seen.Add(Id);
        }
        return true;
    }

    bool Transform(const FValue& Value, const FString& Path)
    {
        FObject V;
        if (!Object(Value, Path, V) || !Keys(V, {TEXT("position"), TEXT("rotation")}, Path) ||
            !Tuple(Field(V, TEXT("position")), 3, Path + TEXT(".position")) ||
            !Tuple(Field(V, TEXT("rotation")), 4, Path + TEXT(".rotation"))) return false;
        const FValues& Q = Field(V, TEXT("rotation"))->AsArray();
        // hypot avoids overflow for finite but malformed large components, as Math.hypot does.
        const double Length = std::hypot(std::hypot(Q[0]->AsNumber(), Q[1]->AsNumber()), std::hypot(Q[2]->AsNumber(), Q[3]->AsNumber()));
        return std::abs(Length - 1.0) <= 1e-6 || Fail(Path + TEXT(".rotation"), TEXT("expected unit quaternion"));
    }

    bool Quantity(const FValue& Value, const FString& Path)
    {
        FObject V;
        if (!Object(Value, Path, V) || !OneOf(Field(V, TEXT("status")), {TEXT("known"), TEXT("unknown")}, Path + TEXT(".status"))) return false;
        const bool bKnown = Same(String(V, TEXT("status")), TEXT("known"));
        if (!Keys(V, bKnown ? TArray<FString>{TEXT("status"), TEXT("unit"), TEXT("value"), TEXT("provenance"), TEXT("source")} :
            TArray<FString>{TEXT("status"), TEXT("unit")}, Path) || !Text(Field(V, TEXT("unit")), Path + TEXT(".unit"))) return false;
        if (bKnown)
        {
            const FValue N = Field(V, TEXT("value"));
            if (!HasType(N, EJson::Number) || !std::isfinite(N->AsNumber())) return Fail(Path + TEXT(".value"), TEXT("expected finite number"));
            if (!OneOf(Field(V, TEXT("provenance")), {TEXT("placeholder"), TEXT("user"), TEXT("manufacturer"), TEXT("measured"), TEXT("checked")}, Path + TEXT(".provenance")) ||
                !Text(Field(V, TEXT("source")), Path + TEXT(".source"))) return false;
        }
        return true;
    }

    bool Record(const FValue& Value, const FString& Path)
    {
        FObject V;
        if (!Object(Value, Path, V) || !Text(Field(V, TEXT("kind")), Path + TEXT(".kind"))) return false;
        const FString Kind = String(V, TEXT("kind"));
        TArray<FString> Fields;
        if (Same(Kind, TEXT("asset_definition"))) Fields = {TEXT("catalogId"), TEXT("category"), TEXT("specifications")};
        else if (Same(Kind, TEXT("inventory_item"))) Fields = {TEXT("definitionId"), TEXT("serialNumber"), TEXT("serviceStatus")};
        else if (Same(Kind, TEXT("stock_pool"))) Fields = {TEXT("definitionId"), TEXT("quantity")};
        else if (Same(Kind, TEXT("asset_instance"))) Fields = {TEXT("definitionId"), TEXT("inventoryItemId"), TEXT("transform")};
        else if (Same(Kind, TEXT("assembly"))) Fields = {TEXT("instanceIds")};
        else if (Same(Kind, TEXT("surface"))) Fields = {TEXT("shape"), TEXT("transform"), TEXT("width"), TEXT("height")};
        else if (Same(Kind, TEXT("zone"))) Fields = {TEXT("role"), TEXT("shape"), TEXT("transform"), TEXT("sizeMeters")};
        else if (Same(Kind, TEXT("port"))) Fields = {TEXT("instanceId"), TEXT("domain"), TEXT("direction"), TEXT("connector"), TEXT("protocol")};
        else if (Same(Kind, TEXT("connection"))) Fields = {TEXT("domain"), TEXT("sourcePortId"), TEXT("targetPortId")};
        else if (Same(Kind, TEXT("mechanical_attachment"))) Fields = {TEXT("parentInstanceId"), TEXT("childInstanceId"), TEXT("parentSocketId"), TEXT("childSocketId")};
        else if (Same(Kind, TEXT("document_snapshot"))) Fields = {TEXT("projectRevision"), TEXT("templateId"), TEXT("templateVersion"), TEXT("status"), TEXT("includedRecordIds")};
        else return Fail(Path + TEXT(".kind"), TEXT("unsupported record kind"));
        TArray<FString> AllFields = {TEXT("id"), TEXT("kind"), TEXT("label"), TEXT("locked")};
        AllFields.Append(Fields);
        if (!Keys(V, AllFields, Path) || !Text(Field(V, TEXT("id")), Path + TEXT(".id")) ||
            !Text(Field(V, TEXT("label")), Path + TEXT(".label"))) return false;
        if (!HasType(Field(V, TEXT("locked")), EJson::Boolean)) return Fail(Path + TEXT(".locked"), TEXT("expected boolean"));
        for (const FString& Name : Fields)
        {
            const FString P = Path + TEXT(".") + Name;
            const FValue Val = Field(V, *Name);
            if (Same(Name, TEXT("transform"))) { if (!Transform(Val, P)) return false; }
            else if (Same(Name, TEXT("instanceIds")) || Same(Name, TEXT("includedRecordIds"))) { if (!Strings(Val, P)) return false; }
            else if (Same(Name, TEXT("quantity")) || Same(Name, TEXT("projectRevision"))) { if (!Natural(Val, P)) return false; }
            else if (Same(Name, TEXT("width")) || Same(Name, TEXT("height")))
            {
                if (!Quantity(Val, P)) return false;
                const FObject& Q = Val->AsObject();
                if (!Same(String(Q, TEXT("unit")), TEXT("m")) ||
                    (Same(String(Q, TEXT("status")), TEXT("known")) && Number(Q, TEXT("value")) <= 0.0))
                    return Fail(P, TEXT("expected positive metres or unknown metres"));
            }
            else if (Same(Name, TEXT("sizeMeters")))
            {
                if (!Tuple(Val, 3, P)) return false;
                for (const FValue& Dimension : Val->AsArray())
                    if (Dimension->AsNumber() <= 0.0) return Fail(P, TEXT("expected positive dimensions"));
            }
            else if (Same(Name, TEXT("specifications")))
            {
                FObject Specs;
                if (!Object(Val, P, Specs)) return false;
                for (const auto& Entry : Specs->Values)
                {
                    const FString SpecName(Entry.Key.Len(), *Entry.Key);
                    if (!HasNonWhitespace(SpecName)) return Fail(P, TEXT("expected nonempty string"));
                    if (!Quantity(Entry.Value, P + TEXT(".") + SpecName)) return false;
                }
            }
            else if (Same(Name, TEXT("domain"))) { if (!OneOf(Val, {TEXT("power"), TEXT("video"), TEXT("audio"), TEXT("data")}, P)) return false; }
            else if (Same(Name, TEXT("direction"))) { if (!OneOf(Val, {TEXT("input"), TEXT("output"), TEXT("bidirectional")}, P)) return false; }
            else if (Same(Name, TEXT("serviceStatus"))) { if (!OneOf(Val, {TEXT("available"), TEXT("unavailable"), TEXT("unknown")}, P)) return false; }
            else if (Same(Name, TEXT("status"))) { if (!OneOf(Val, {TEXT("draft"), TEXT("issued")}, P)) return false; }
            else if (Same(Name, TEXT("shape"))) { if (!OneOf(Val, {Same(Kind, TEXT("surface")) ? TEXT("plane") : TEXT("box")}, P)) return false; }
            else if (Same(Name, TEXT("role"))) { if (!OneOf(Val, {TEXT("audience"), TEXT("keep_out"), TEXT("listening"), TEXT("target"), TEXT("termination"), TEXT("routing")}, P)) return false; }
            else if ((Same(Name, TEXT("inventoryItemId")) || Same(Name, TEXT("serialNumber")) || Same(Name, TEXT("connector")) || Same(Name, TEXT("protocol"))) && HasType(Val, EJson::Null)) {}
            else if (!Text(Val, P)) return false;
        }
        return true;
    }
};

/** Strict JSON grammar gate: no comments, trailing commas, permissive numbers or trailing documents. */
class FJsonSyntax
{
public:
    explicit FJsonSyntax(const FString& InText) : Text(InText) {}
    bool Check()
    {
        TArray<EState> Stack;
        Stack.Add(EState::RootValue);
        while (!Stack.IsEmpty())
        {
            SkipWhitespace();
            const int32 Top = Stack.Num() - 1;
            switch (Stack[Top])
            {
            case EState::RootValue:
                Stack[Top] = EState::RootEnd;
                if (!Value(Stack)) return false;
                break;
            case EState::RootEnd:
                return Offset == Text.Len();
            case EState::ObjectFirst:
                if (Take(TEXT('}'))) { Stack.RemoveAt(Top); break; }
                Stack[Top] = EState::ObjectKey;
                break;
            case EState::ObjectKey:
                if (!QuotedString()) return false;
                Stack[Top] = EState::ObjectColon;
                break;
            case EState::ObjectColon:
                if (!Take(TEXT(':'))) return false;
                Stack[Top] = EState::ObjectValue;
                break;
            case EState::ObjectValue:
                Stack[Top] = EState::ObjectEnd;
                if (!Value(Stack)) return false;
                break;
            case EState::ObjectEnd:
                if (Take(TEXT('}'))) Stack.RemoveAt(Top);
                else if (Take(TEXT(','))) Stack[Top] = EState::ObjectKey;
                else return false;
                break;
            case EState::ArrayFirst:
                if (Take(TEXT(']'))) { Stack.RemoveAt(Top); break; }
                Stack[Top] = EState::ArrayValue;
                break;
            case EState::ArrayValue:
                Stack[Top] = EState::ArrayEnd;
                if (!Value(Stack)) return false;
                break;
            case EState::ArrayEnd:
                if (Take(TEXT(']'))) Stack.RemoveAt(Top);
                else if (Take(TEXT(','))) Stack[Top] = EState::ArrayValue;
                else return false;
                break;
            }
        }
        return false;
    }

private:
    enum class EState : uint8 { RootValue, RootEnd, ObjectFirst, ObjectKey, ObjectColon, ObjectValue, ObjectEnd, ArrayFirst, ArrayValue, ArrayEnd };
    const FString& Text;
    int32 Offset = 0;

    TCHAR Peek() const { return Offset < Text.Len() ? Text[Offset] : 0; }
    bool Take(TCHAR C) { if (Offset < Text.Len() && Text[Offset] == C) { ++Offset; return true; } return false; }
    static bool Digit(TCHAR C) { return C >= TEXT('0') && C <= TEXT('9'); }
    static bool Hex(TCHAR C) { return Digit(C) || (C >= TEXT('a') && C <= TEXT('f')) || (C >= TEXT('A') && C <= TEXT('F')); }
    void SkipWhitespace()
    {
        while (Offset < Text.Len() && (Peek() == TEXT(' ') || Peek() == TEXT('\t') || Peek() == TEXT('\r') || Peek() == TEXT('\n'))) ++Offset;
    }
    bool Literal(const TCHAR* Expected)
    {
        for (int32 I = 0; Expected[I] != 0; ++I) if (!Take(Expected[I])) return false;
        return true;
    }
    bool QuotedString()
    {
        if (!Take(TEXT('"'))) return false;
        while (Offset < Text.Len())
        {
            const TCHAR C = Text[Offset++];
            if (C == TEXT('"')) return true;
            if (static_cast<uint32>(C) < 0x20) return false;
            if (C != TEXT('\\')) continue;
            if (Offset == Text.Len()) return false;
            const TCHAR Escape = Text[Offset++];
            if (Escape == TEXT('u'))
            {
                for (int32 I = 0; I < 4; ++I) { if (Offset == Text.Len() || !Hex(Text[Offset])) return false; ++Offset; }
            }
            else if (Escape != TEXT('"') && Escape != TEXT('\\') && Escape != TEXT('/') && Escape != TEXT('b') &&
                Escape != TEXT('f') && Escape != TEXT('n') && Escape != TEXT('r') && Escape != TEXT('t')) return false;
        }
        return false;
    }
    bool JsonNumber()
    {
        Take(TEXT('-'));
        if (!Take(TEXT('0')))
        {
            if (Peek() < TEXT('1') || Peek() > TEXT('9')) return false;
            do { ++Offset; } while (Digit(Peek()));
        }
        if (Take(TEXT('.')))
        {
            if (!Digit(Peek())) return false;
            do { ++Offset; } while (Digit(Peek()));
        }
        if (Take(TEXT('e')) || Take(TEXT('E')))
        {
            if (!Take(TEXT('+'))) Take(TEXT('-'));
            if (!Digit(Peek())) return false;
            do { ++Offset; } while (Digit(Peek()));
        }
        return true;
    }
    bool Value(TArray<EState>& Stack)
    {
        if (Take(TEXT('{'))) { Stack.Add(EState::ObjectFirst); return true; }
        if (Take(TEXT('['))) { Stack.Add(EState::ArrayFirst); return true; }
        if (Peek() == TEXT('"')) return QuotedString();
        if (Peek() == TEXT('t')) return Literal(TEXT("true"));
        if (Peek() == TEXT('f')) return Literal(TEXT("false"));
        if (Peek() == TEXT('n')) return Literal(TEXT("null"));
        return JsonNumber();
    }
};

void AppendQuoted(const FString& Value, FString& Out)
{
    Out.AppendChar(TEXT('"'));
    for (int32 I = 0; I < Value.Len(); ++I)
    {
        const TCHAR C = Value[I];
        const uint32 Code = static_cast<uint32>(C);
        if (C == TEXT('"')) Out += TEXT("\\\"");
        else if (C == TEXT('\\')) Out += TEXT("\\\\");
        // Escaping surrogate code units keeps lone surrogates JSON-round-trippable.
        else if (Code < 0x20 || (Code >= 0xd800 && Code <= 0xdfff)) Out += FString::Printf(TEXT("\\u%04x"), Code);
        else Out.AppendChar(C);
    }
    Out.AppendChar(TEXT('"'));
}

void Indent(FString& Out, int32 Depth)
{
    Out.AppendChar(TEXT('\n'));
    for (int32 I = 0; I < Depth * 2; ++I) Out.AppendChar(TEXT(' '));
}

bool AppendJson(const FValue& Value, FString& Out, int32 Depth)
{
    // Called only on a validated project: every branch has finite, typed data,
    // and the fixed schema bounds nesting independently of the record count.
    switch (Value->Type)
    {
    case EJson::Null: Out += TEXT("null"); return true;
    case EJson::Boolean: Out += Value->AsBool() ? TEXT("true") : TEXT("false"); return true;
    case EJson::String: AppendQuoted(Value->AsString(), Out); return true;
    case EJson::Number:
    {
        const double N = Value->AsNumber();
        if (N == 0.0) { Out += TEXT("0"); return true; }
        // Do not route doubles through float or locale-dependent sanitization.
        // max_digits10 guarantees a binary64 -> JSON -> binary64 round trip.
        char Buffer[64];
        const auto Result = std::to_chars(Buffer, Buffer + sizeof(Buffer), N, std::chars_format::general, std::numeric_limits<double>::max_digits10);
        if (Result.ec != std::errc()) return false;
        for (const char* C = Buffer; C != Result.ptr; ++C) Out.AppendChar(static_cast<TCHAR>(*C));
        return true;
    }
    case EJson::Array:
    {
        Out.AppendChar(TEXT('['));
        const FValues& Array = Value->AsArray();
        for (int32 I = 0; I < Array.Num(); ++I)
        {
            if (I > 0) Out.AppendChar(TEXT(','));
            Indent(Out, Depth + 1);
            if (!AppendJson(Array[I], Out, Depth + 1)) return false;
        }
        if (!Array.IsEmpty()) Indent(Out, Depth);
        Out.AppendChar(TEXT(']'));
        return true;
    }
    case EJson::Object:
    {
        Out.AppendChar(TEXT('{'));
        bool bFirst = true;
        for (const auto& Entry : Value->AsObject()->Values)
        {
            if (!bFirst) Out.AppendChar(TEXT(','));
            bFirst = false;
            Indent(Out, Depth + 1);
            AppendQuoted(FString(Entry.Key.Len(), *Entry.Key), Out);
            Out += TEXT(": ");
            if (!AppendJson(Entry.Value, Out, Depth + 1)) return false;
        }
        if (!bFirst) Indent(Out, Depth);
        Out.AppendChar(TEXT('}'));
        return true;
    }
    default: return false;
    }
}
}

bool FSpatialPrevisProjectCodec::Parse(const FString& Json, TSharedPtr<FJsonObject>& OutProject, FString& OutError)
{
    if (!FJsonSyntax(Json).Check()) { OutError = TEXT("project: invalid JSON"); return false; }
    int32 RootOffset = 0;
    while (Json[RootOffset] == TEXT(' ') || Json[RootOffset] == TEXT('\t') || Json[RootOffset] == TEXT('\r') || Json[RootOffset] == TEXT('\n')) ++RootOffset;
    // Valid scalar/array JSON is a schema error even on UE versions whose
    // deserializer accepts only object/array roots.
    if (Json[RootOffset] != TEXT('{')) { OutError = TEXT("project: expected object"); return false; }
    FValue Value;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
    if (!FJsonSerializer::Deserialize(Reader, Value)) { OutError = TEXT("project: invalid JSON"); return false; }
    if (!HasType(Value, EJson::Object)) { OutError = TEXT("project: expected object"); return false; }
    const FObject Candidate = Value->AsObject();
    if (!Validate(Candidate, OutError)) return false;
    OutProject = Candidate;
    return true;
}

bool FSpatialPrevisProjectCodec::Validate(const TSharedPtr<FJsonObject>& Project, FString& OutError)
{
    FString Error;
    if (!FValidator(Error).Project(Project)) { OutError = MoveTemp(Error); return false; }
    OutError.Reset();
    return true;
}

bool FSpatialPrevisProjectCodec::Serialize(const TSharedPtr<FJsonObject>& Project, FString& OutJson, FString& OutError)
{
    if (!Validate(Project, OutError)) return false;
    FString Candidate;
    if (!AppendJson(MakeShared<FJsonValueObject>(Project), Candidate, 0))
    {
        OutError = TEXT("project: JSON serialization failed");
        return false;
    }
    OutJson = MoveTemp(Candidate);
    return true;
}
