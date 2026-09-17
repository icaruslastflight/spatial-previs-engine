#include "SpatialPrevisWorkspaceCodec.h"

#include "SpatialPrevisProjectCodec.h"
#include "SpatialPrevisDateParse.h"
#include "Containers/StringConv.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/Crc.h"

#include <charconv>
#include <cmath>
#include <initializer_list>
#include <system_error>

namespace
{
using FObject = TSharedPtr<FJsonObject>;
using FValue = TSharedPtr<FJsonValue>;
using FValues = TArray<FValue>;

bool Same(const FString& A, const FString& B)
{
    return A.Len() == B.Len() && (A.IsEmpty() || FMemory::Memcmp(*A, *B, A.Len() * sizeof(TCHAR)) == 0);
}

struct FExactString
{
    FString Value;
    FExactString() = default;
    FExactString(const FString& InValue) : Value(InValue) {}
    bool operator==(const FExactString& Other) const { return Same(Value, Other.Value); }
    friend uint32 GetTypeHash(const FExactString& Key) { return FCrc::MemCrc32(*Key.Value, Key.Value.Len() * sizeof(TCHAR)); }
};

bool Type(const FValue& Value, EJson Expected) { return Value.IsValid() && Value->Type == Expected; }

FValue Field(const FObject& Object, const TCHAR* Name)
{
    if (!Object.IsValid()) return nullptr;
    for (const auto& Pair : Object->Values)
        if (Same(FString(Pair.Key.Len(), *Pair.Key), Name)) return Pair.Value;
    return nullptr;
}

bool HasField(const FObject& Object, const TCHAR* Name)
{
    if (!Object.IsValid()) return false;
    for (const auto& Pair : Object->Values)
        if (Same(FString(Pair.Key.Len(), *Pair.Key), Name)) return true;
    return false;
}

// These convenience getters are used only after shape validation, or on the
// typed project graph accepted by ProjectCodec.
FString Str(const FObject& Object, const TCHAR* Name) { return Field(Object, Name)->AsString(); }
double Num(const FObject& Object, const TCHAR* Name) { return Field(Object, Name)->AsNumber(); }
const FValues& Array(const FObject& Object, const TCHAR* Name) { return Field(Object, Name)->AsArray(); }

bool NonWhitespace(const FString& String)
{
    for (int32 I = 0; I < String.Len(); ++I)
    {
        const uint32 C = static_cast<uint32>(String[I]);
        const bool Whitespace = (C >= 9 && C <= 13) || C == 0x20 || C == 0xa0 || C == 0x1680 ||
            (C >= 0x2000 && C <= 0x200a) || C == 0x2028 || C == 0x2029 || C == 0x202f ||
            C == 0x205f || C == 0x3000 || C == 0xfeff;
        if (!Whitespace) return true;
    }
    return false;
}

TArray<uint16> Utf16(const FString& String)
{
    TArray<uint16> Units;
    Units.Reserve(String.Len());
    for (int32 I = 0; I < String.Len(); ++I)
    {
        const uint32 C = static_cast<uint32>(String[I]);
        if (C <= 0xffff) Units.Add(static_cast<uint16>(C));
        else
        {
            Units.Add(static_cast<uint16>(0xd800 + ((C - 0x10000) >> 10)));
            Units.Add(static_cast<uint16>(0xdc00 + ((C - 0x10000) & 0x3ff)));
        }
    }
    return Units;
}

bool Less(const FString& A, const FString& B)
{
    // JavaScript string order is UTF-16 code-unit order, not locale, case-folded
    // order or Unicode scalar order (astral characters sort before U+E000).
    const TArray<uint16> Left = Utf16(A), Right = Utf16(B);
    for (int32 I = 0; I < FMath::Min(Left.Num(), Right.Num()); ++I)
        if (Left[I] != Right[I]) return Left[I] < Right[I];
    return Left.Num() < Right.Num();
}

FValue CopyValue(const FValue& Value)
{
    if (!Value.IsValid()) return nullptr;
    switch (Value->Type)
    {
    case EJson::Null: return MakeShared<FJsonValueNull>();
    case EJson::Boolean: return MakeShared<FJsonValueBoolean>(Value->AsBool());
    case EJson::Number: return MakeShared<FJsonValueNumber>(Value->AsNumber());
    case EJson::String: return MakeShared<FJsonValueString>(Value->AsString());
    case EJson::Array:
    {
        FValues Result;
        Result.Reserve(Value->AsArray().Num());
        for (const FValue& Item : Value->AsArray()) Result.Add(CopyValue(Item));
        return MakeShared<FJsonValueArray>(Result);
    }
    case EJson::Object:
        return MakeShared<FJsonValueObject>(FSpatialPrevisWorkspaceCodec::Clone(Value->AsObject()));
    default: return nullptr;
    }
}

void Quote(const FString& Value, FString& Out)
{
    Out.AppendChar(TEXT('"'));
    for (int32 I = 0; I < Value.Len(); ++I)
    {
        const TCHAR C = Value[I];
        const uint32 Code = static_cast<uint32>(C);
        switch (C)
        {
        case TEXT('"'): Out += TEXT("\\\""); break;
        case TEXT('\\'): Out += TEXT("\\\\"); break;
        case TEXT('\b'): Out += TEXT("\\b"); break;
        case TEXT('\t'): Out += TEXT("\\t"); break;
        case TEXT('\n'): Out += TEXT("\\n"); break;
        case TEXT('\f'): Out += TEXT("\\f"); break;
        case TEXT('\r'): Out += TEXT("\\r"); break;
        default:
            if (Code >= 0xd800 && Code <= 0xdbff && I + 1 < Value.Len() &&
                static_cast<uint32>(Value[I + 1]) >= 0xdc00 && static_cast<uint32>(Value[I + 1]) <= 0xdfff)
            {
                Out.AppendChar(C);
                Out.AppendChar(Value[++I]);
            }
            else if (Code < 0x20 || (Code >= 0xd800 && Code <= 0xdfff)) Out += FString::Printf(TEXT("\\u%04x"), Code);
            else Out.AppendChar(C);
            break;
        }
    }
    Out.AppendChar(TEXT('"'));
}

void JsonNumber(double Number, FString& Out)
{
    if (!std::isfinite(Number)) { Out += TEXT("null"); return; }
    if (Number == 0.0) { Out += TEXT("0"); return; }
    if (Number < 0.0) { Out.AppendChar(TEXT('-')); Number = -Number; }
    char Buffer[64];
    // The shortest correctly rounded decimal digits are independent of the
    // presentation threshold. Reformat the exponent to ECMAScript's -6/21
    // boundaries instead of C++ general formatting's -4/precision rules.
    const auto Result = std::to_chars(Buffer, Buffer + sizeof(Buffer), Number, std::chars_format::general);
    check(Result.ec == std::errc());
    FString Digits;
    int32 Point = 0;
    bool SawPoint = false;
    const char* Cursor = Buffer;
    for (; Cursor != Result.ptr && *Cursor != 'e' && *Cursor != 'E'; ++Cursor)
    {
        if (*Cursor == '.') SawPoint = true;
        else { Digits.AppendChar(static_cast<TCHAR>(*Cursor)); if (!SawPoint) ++Point; }
    }
    if (Cursor != Result.ptr)
    {
        ++Cursor;
        int32 Sign = 1, Exponent = 0;
        if (*Cursor == '-' || *Cursor == '+') { if (*Cursor == '-') Sign = -1; ++Cursor; }
        for (; Cursor != Result.ptr; ++Cursor) Exponent = Exponent * 10 + (*Cursor - '0');
        Point += Sign * Exponent;
    }
    while (Digits.Len() > 1 && Digits[0] == TEXT('0')) { Digits.RemoveAt(0, 1); --Point; }
    while (Digits.Len() > 1 && Digits[Digits.Len() - 1] == TEXT('0')) Digits.RemoveAt(Digits.Len() - 1, 1);
    if (Digits.Len() <= Point && Point <= 21)
    {
        Out += Digits;
        for (int32 I = Digits.Len(); I < Point; ++I) Out.AppendChar(TEXT('0'));
    }
    else if (Point > 0 && Point <= 21)
    {
        Out += Digits.Left(Point);
        Out.AppendChar(TEXT('.'));
        Out += Digits.Mid(Point);
    }
    else if (Point > -6 && Point <= 0)
    {
        Out += TEXT("0.");
        for (int32 I = 0; I < -Point; ++I) Out.AppendChar(TEXT('0'));
        Out += Digits;
    }
    else
    {
        Out.AppendChar(Digits[0]);
        if (Digits.Len() > 1) { Out.AppendChar(TEXT('.')); Out += Digits.Mid(1); }
        Out.AppendChar(TEXT('e'));
        if (Point - 1 >= 0) Out.AppendChar(TEXT('+'));
        Out += FString::FromInt(Point - 1);
    }
}

void WriteCanonical(const FValue& Value, FString& Out)
{
    if (!Value.IsValid()) { Out += TEXT("null"); return; }
    switch (Value->Type)
    {
    case EJson::Null: Out += TEXT("null"); break;
    case EJson::Boolean: Out += Value->AsBool() ? TEXT("true") : TEXT("false"); break;
    case EJson::String: Quote(Value->AsString(), Out); break;
    case EJson::Number: JsonNumber(Value->AsNumber(), Out); break;
    case EJson::Array:
    {
        Out.AppendChar(TEXT('['));
        bool First = true;
        for (const FValue& Item : Value->AsArray())
        {
            if (!First) Out.AppendChar(TEXT(','));
            First = false;
            WriteCanonical(Item, Out);
        }
        Out.AppendChar(TEXT(']'));
        break;
    }
    case EJson::Object:
    {
        const FObject& Object = Value->AsObject();
        TArray<TPair<FString, FValue>> Entries;
        Entries.Reserve(Object->Values.Num());
        for (const auto& Pair : Object->Values) Entries.Emplace(FString(Pair.Key.Len(), *Pair.Key), Pair.Value);
        Entries.Sort([](const TPair<FString, FValue>& A, const TPair<FString, FValue>& B) { return Less(A.Key, B.Key); });
        Out.AppendChar(TEXT('{'));
        bool First = true;
        for (const auto& Pair : Entries)
        {
            if (!First) Out.AppendChar(TEXT(','));
            First = false;
            Quote(Pair.Key, Out);
            Out.AppendChar(TEXT(':'));
            WriteCanonical(Pair.Value, Out);
        }
        Out.AppendChar(TEXT('}'));
        break;
    }
    default: Out += TEXT("null"); break;
    }
}

FObject WithRecords(const FObject& Project, const FValue& Records)
{
    const FObject Result = MakeShared<FJsonObject>();
    for (const auto& Pair : Project->Values) Result->SetField(FString(Pair.Key.Len(), *Pair.Key), Pair.Value);
    Result->SetField(TEXT("records"), Records);
    return Result;
}

void Sha256(const uint8* Data, uint64 Length, uint8 (&Digest)[32])
{
    // FIPS 180-4 SHA-256. UE5.8's generic GetSHA256Signature asserts on Windows;
    // this small integer-only implementation avoids that platform stub and any
    // account, crypto-provider or third-party runtime dependency.
    static constexpr uint32 Constants[64] = {
        0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
        0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
        0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
        0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
        0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
        0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
        0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
        0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
    };
    uint32 State[8] = {0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
    auto Rotate = [](uint32 Value, uint32 Count) { return (Value >> Count) | (Value << (32u - Count)); };
    auto Compress = [&](const uint8* Block)
    {
        uint32 Words[64];
        for (uint32 I = 0; I < 16; ++I)
            Words[I] = (uint32(Block[I * 4]) << 24) | (uint32(Block[I * 4 + 1]) << 16) |
                (uint32(Block[I * 4 + 2]) << 8) | uint32(Block[I * 4 + 3]);
        for (uint32 I = 16; I < 64; ++I)
        {
            const uint32 A = Words[I - 15], B = Words[I - 2];
            const uint32 S0 = Rotate(A, 7) ^ Rotate(A, 18) ^ (A >> 3);
            const uint32 S1 = Rotate(B, 17) ^ Rotate(B, 19) ^ (B >> 10);
            Words[I] = Words[I - 16] + S0 + Words[I - 7] + S1;
        }
        uint32 A = State[0], B = State[1], C = State[2], D = State[3];
        uint32 E = State[4], F = State[5], G = State[6], H = State[7];
        for (uint32 I = 0; I < 64; ++I)
        {
            const uint32 S1 = Rotate(E, 6) ^ Rotate(E, 11) ^ Rotate(E, 25);
            const uint32 Choice = (E & F) ^ (~E & G);
            const uint32 T1 = H + S1 + Choice + Constants[I] + Words[I];
            const uint32 S0 = Rotate(A, 2) ^ Rotate(A, 13) ^ Rotate(A, 22);
            const uint32 Majority = (A & B) ^ (A & C) ^ (B & C);
            const uint32 T2 = S0 + Majority;
            H = G; G = F; F = E; E = D + T1;
            D = C; C = B; B = A; A = T1 + T2;
        }
        State[0] += A; State[1] += B; State[2] += C; State[3] += D;
        State[4] += E; State[5] += F; State[6] += G; State[7] += H;
    };
    uint64 Offset = 0;
    while (Length - Offset >= 64) { Compress(Data + Offset); Offset += 64; }
    uint8 Tail[128]{};
    const uint32 Remaining = static_cast<uint32>(Length - Offset);
    for (uint32 I = 0; I < Remaining; ++I) Tail[I] = Data[Offset + I];
    Tail[Remaining] = 0x80;
    const uint32 TailSize = Remaining < 56 ? 64 : 128;
    const uint64 Bits = Length * 8;
    for (uint32 I = 0; I < 8; ++I) Tail[TailSize - 1 - I] = static_cast<uint8>(Bits >> (8 * I));
    Compress(Tail);
    if (TailSize == 128) Compress(Tail + 64);
    for (uint32 I = 0; I < 8; ++I)
        for (uint32 J = 0; J < 4; ++J) Digest[I * 4 + J] = static_cast<uint8>(State[I] >> (24 - J * 8));
}

class FValidator
{
public:
    explicit FValidator(FString& OutError) : Error(OutError) {}

    bool Validate(const FObject& Workspace)
    {
        if (!Workspace.IsValid()) return Fail(TEXT("expected object"));
        if (!Fields(Workspace, {TEXT("format"), TEXT("version"), TEXT("project"), TEXT("acceptedKeys"), TEXT("undo"), TEXT("redo"), TEXT("checks"), TEXT("reviews"), TEXT("issued")})) return false;
        if (!Equals(Field(Workspace, TEXT("format")), TEXT("spatial-previs-workspace")) ||
            !Type(Field(Workspace, TEXT("version")), EJson::Number) || Num(Workspace, TEXT("version")) != 1.0)
            return Fail(TEXT("unsupported workspace version"));
        FObject Project;
        if (!Object(Field(Workspace, TEXT("project")), Project)) return false;
        if (!FSpatialPrevisProjectCodec::Validate(Project, Error)) return false;
        if (!Strings(Field(Workspace, TEXT("acceptedKeys")))) return false;
        TSet<FExactString> Accepted;
        for (const FValue& Key : Array(Workspace, TEXT("acceptedKeys")))
        {
            if (Accepted.Contains(FExactString(Key->AsString()))) return Fail(TEXT("duplicate idempotency key"));
            Accepted.Add(FExactString(Key->AsString()));
        }
        for (const TCHAR* Direction : {TEXT("undo"), TEXT("redo")})
        {
            if (!List(Field(Workspace, Direction))) return false;
            for (const FValue& EntryValue : Array(Workspace, Direction))
            {
                FObject Entry;
                if (!Object(EntryValue, Entry) || !Fields(Entry, {TEXT("key"), TEXT("label"), TEXT("before"), TEXT("after")}) ||
                    !String(Field(Entry, TEXT("key"))) || !String(Field(Entry, TEXT("label")))) return false;
                if (!Accepted.Contains(FExactString(Str(Entry, TEXT("key"))))) return Fail(TEXT("history key is not in journal"));
                for (const TCHAR* Side : {TEXT("before"), TEXT("after")})
                    if (!FSpatialPrevisProjectCodec::Validate(WithRecords(Project, Field(Entry, Side)), Error)) return false;
            }
        }
        TSet<FExactString> HistoryKeys;
        for (const TCHAR* Direction : {TEXT("undo"), TEXT("redo")})
        {
            FString Expected = FSpatialPrevisWorkspaceCodec::Canonical(Field(Project, TEXT("records")));
            const FValues& History = Array(Workspace, Direction);
            for (int32 I = History.Num() - 1; I >= 0; --I)
            {
                const FObject& Entry = History[I]->AsObject();
                const FExactString Key(Str(Entry, TEXT("key")));
                if (HistoryKeys.Contains(Key)) return Fail(TEXT("duplicate history entry"));
                HistoryKeys.Add(Key);
                const bool Undo = Same(Direction, TEXT("undo"));
                const FValue From = Field(Entry, Undo ? TEXT("after") : TEXT("before"));
                const FValue To = Field(Entry, Undo ? TEXT("before") : TEXT("after"));
                if (!Same(FSpatialPrevisWorkspaceCodec::Canonical(From), Expected)) return Fail(TEXT("history does not match project"));
                for (const FValue& Record : From->AsArray())
                {
                    const FObject& R = Record->AsObject();
                    if (Same(Str(R, TEXT("kind")), TEXT("document_snapshot")) && Same(Str(R, TEXT("status")), TEXT("issued")))
                    {
                        FValue Target = MakeShared<FJsonValueNull>();
                        for (const FValue& Candidate : To->AsArray())
                            if (Same(Str(Candidate->AsObject(), TEXT("id")), Str(R, TEXT("id")))) { Target = Candidate; break; }
                        if (!Same(FSpatialPrevisWorkspaceCodec::Canonical(Target), FSpatialPrevisWorkspaceCodec::Canonical(Record)))
                            return Fail(TEXT("history changes issued snapshot"));
                    }
                }
                Expected = FSpatialPrevisWorkspaceCodec::Canonical(To);
            }
        }
        TSet<FExactString> Ids;
        for (const FValue& Record : Array(Project, TEXT("records"))) Ids.Add(FExactString(Str(Record->AsObject(), TEXT("id"))));
        if (!List(Field(Workspace, TEXT("checks")))) return false;
        TMap<FExactString, FObject> Checks;
        for (const FValue& Value : Array(Workspace, TEXT("checks")))
        {
            FObject Check;
            if (!Object(Value, Check) || !Fields(Check, {TEXT("id"), TEXT("scope"), TEXT("model"), TEXT("modelVersion"), TEXT("inputRevision"), TEXT("inputHash"), TEXT("status"), TEXT("summary"), TEXT("assumptions"), TEXT("uncertainty"), TEXT("evidence")}) || !Identity(Check, Ids)) return false;
            for (const TCHAR* Name : {TEXT("model"), TEXT("modelVersion"), TEXT("inputHash"), TEXT("summary")})
                if (!String(Field(Check, Name))) return false;
            const FString Hash = Str(Check, TEXT("inputHash"));
            if (Hash.Len() != 64) return Fail(TEXT("invalid input hash"));
            for (int32 I = 0; I < Hash.Len(); ++I)
                if (!((Hash[I] >= TEXT('a') && Hash[I] <= TEXT('f')) || (Hash[I] >= TEXT('0') && Hash[I] <= TEXT('9')))) return Fail(TEXT("invalid input hash"));
            for (const TCHAR* Name : {TEXT("scope"), TEXT("assumptions"), TEXT("uncertainty"), TEXT("evidence")})
                if (!Strings(Field(Check, Name))) return false;
            TSet<FExactString> Scope;
            for (const FValue& Id : Array(Check, TEXT("scope"))) Scope.Add(FExactString(Id->AsString()));
            if (Scope.IsEmpty() || Scope.Num() != Array(Check, TEXT("scope")).Num()) return Fail(TEXT("invalid scope"));
            if (!Revision(Field(Check, TEXT("inputRevision")), Num(Project, TEXT("revision"))) ||
                !OneOf(Field(Check, TEXT("status")), {TEXT("pass"), TEXT("fail"), TEXT("needs_data"), TEXT("not_evaluated"), TEXT("stale")}, TEXT("invalid check status"))) return false;
            Checks.Add(FExactString(Str(Check, TEXT("id"))), Check);
        }
        if (!List(Field(Workspace, TEXT("reviews")))) return false;
        TSet<FExactString> ReviewIds;
        for (const FValue& Value : Array(Workspace, TEXT("reviews")))
        {
            FObject Review;
            if (!Object(Value, Review) || !Fields(Review, {TEXT("id"), TEXT("checkId"), TEXT("reviewerId"), TEXT("reviewedAt"), TEXT("inputHash"), TEXT("inputRevision"), TEXT("status"), TEXT("evidence")}) || !Identity(Review, Ids)) return false;
            for (const TCHAR* Name : {TEXT("checkId"), TEXT("reviewerId"), TEXT("reviewedAt"), TEXT("inputHash")})
                if (!String(Field(Review, Name))) return false;
            if (!SpatialPrevisDateParse::IsFinite(Str(Review, TEXT("reviewedAt")))) return Fail(TEXT("invalid review date"));
            if (!Strings(Field(Review, TEXT("evidence"))) || !Revision(Field(Review, TEXT("inputRevision")), Num(Project, TEXT("revision"))) ||
                !OneOf(Field(Review, TEXT("status")), {TEXT("current"), TEXT("stale")}, TEXT("invalid review status"))) return false;
            const FObject* Check = Checks.Find(FExactString(Str(Review, TEXT("checkId"))));
            if (!Check) return Fail(TEXT("review references missing check"));
            if (Same(Str(Review, TEXT("status")), TEXT("current")) &&
                (!Same(Str(*Check, TEXT("status")), TEXT("pass")) || !Same(Str(Review, TEXT("inputHash")), Str(*Check, TEXT("inputHash"))) ||
                    Num(Review, TEXT("inputRevision")) != Num(*Check, TEXT("inputRevision"))))
                return Fail(TEXT("review does not match passing check"));
            ReviewIds.Add(FExactString(Str(Review, TEXT("id"))));
        }
        if (!List(Field(Workspace, TEXT("issued")))) return false;
        for (const FValue& Value : Array(Workspace, TEXT("issued")))
        {
            FObject Artifact;
            if (!Object(Value, Artifact) || !Fields(Artifact, {TEXT("id"), TEXT("projectRevision"), TEXT("issuerId"), TEXT("issuedAt"), TEXT("mediaType"), TEXT("content"), TEXT("reviewIds")}) || !Identity(Artifact, Ids)) return false;
            for (const TCHAR* Name : {TEXT("issuerId"), TEXT("issuedAt"), TEXT("content")}) if (!String(Field(Artifact, Name))) return false;
            if (!SpatialPrevisDateParse::IsFinite(Str(Artifact, TEXT("issuedAt")))) return Fail(TEXT("invalid issue date"));
            if (!Equals(Field(Artifact, TEXT("mediaType")), TEXT("application/json"))) return Fail(TEXT("unsupported artifact type"));
            if (!Strings(Field(Artifact, TEXT("reviewIds"))) || !Revision(Field(Artifact, TEXT("projectRevision")), Num(Project, TEXT("revision")))) return false;
            for (const FValue& Id : Array(Artifact, TEXT("reviewIds")))
                if (!ReviewIds.Contains(FExactString(Id->AsString()))) return Fail(TEXT("missing artifact review"));
            FObject Frozen;
            if (!FSpatialPrevisProjectCodec::Parse(Str(Artifact, TEXT("content")), Frozen, Error)) return false;
            if (!Same(Str(Frozen, TEXT("projectId")), Str(Project, TEXT("projectId"))) || Num(Frozen, TEXT("revision")) != Num(Artifact, TEXT("projectRevision")))
                return Fail(TEXT("artifact project/revision mismatch"));
        }
        return true;
    }

private:
    FString& Error;
    bool Fail(const TCHAR* Message) { Error = FString(TEXT("Workspace: ")) + Message; return false; }
    bool Object(const FValue& Value, FObject& Out)
    {
        if (!Type(Value, EJson::Object) || !Value->AsObject().IsValid()) return Fail(TEXT("expected object"));
        Out = Value->AsObject(); return true;
    }
    bool Fields(const FObject& Object, std::initializer_list<const TCHAR*> Names)
    {
        if (Object->Values.Num() != static_cast<int32>(Names.size())) return Fail(TEXT("missing or unsupported fields"));
        for (const TCHAR* Name : Names) if (!HasField(Object, Name)) return Fail(TEXT("missing or unsupported fields"));
        return true;
    }
    bool String(const FValue& Value)
    {
        return (Type(Value, EJson::String) && NonWhitespace(Value->AsString())) || Fail(TEXT("expected nonempty string"));
    }
    bool List(const FValue& Value) { return Type(Value, EJson::Array) || Fail(TEXT("expected array")); }
    bool Strings(const FValue& Value)
    {
        if (!List(Value)) return false;
        for (const FValue& Item : Value->AsArray()) if (!String(Item)) return false;
        return true;
    }
    bool Equals(const FValue& Value, const TCHAR* Expected) { return Type(Value, EJson::String) && Same(Value->AsString(), Expected); }
    bool OneOf(const FValue& Value, std::initializer_list<const TCHAR*> Names, const TCHAR* Message)
    {
        for (const TCHAR* Name : Names) if (Equals(Value, Name)) return true;
        return Fail(Message);
    }
    bool Revision(const FValue& Value, double Maximum)
    {
        if (Type(Value, EJson::Number))
        {
            const double N = Value->AsNumber();
            if (std::isfinite(N) && N >= 0 && N <= 9007199254740991.0 && N <= Maximum && std::floor(N) == N) return true;
        }
        return Fail(TEXT("invalid revision"));
    }
    bool Identity(const FObject& Object, TSet<FExactString>& Ids)
    {
        if (!String(Field(Object, TEXT("id")))) return false;
        const FExactString Id(Str(Object, TEXT("id")));
        if (Ids.Contains(Id)) return Fail(TEXT("duplicate metadata ID"));
        Ids.Add(Id); return true;
    }
};
}

TSharedPtr<FJsonObject> FSpatialPrevisWorkspaceCodec::Clone(const TSharedPtr<FJsonObject>& Object)
{
    if (!Object.IsValid()) return nullptr;
    const FObject Result = MakeShared<FJsonObject>();
    for (const auto& Pair : Object->Values) Result->SetField(FString(Pair.Key.Len(), *Pair.Key), CopyValue(Pair.Value));
    return Result;
}

FString FSpatialPrevisWorkspaceCodec::Canonical(const TSharedPtr<FJsonValue>& Value)
{
    FString Result;
    WriteCanonical(Value, Result);
    return Result;
}

bool FSpatialPrevisWorkspaceCodec::FromProject(const TSharedPtr<FJsonObject>& Project, TSharedPtr<FJsonObject>& OutWorkspace, FString& OutError)
{
    if (!FSpatialPrevisProjectCodec::Validate(Project, OutError)) return false;
    const FObject Workspace = MakeShared<FJsonObject>();
    Workspace->SetStringField(TEXT("format"), TEXT("spatial-previs-workspace"));
    Workspace->SetNumberField(TEXT("version"), 1);
    Workspace->SetObjectField(TEXT("project"), Clone(Project));
    for (const TCHAR* Name : {TEXT("acceptedKeys"), TEXT("undo"), TEXT("redo"), TEXT("checks"), TEXT("reviews"), TEXT("issued")}) Workspace->SetArrayField(Name, FValues{});
    OutWorkspace = Workspace;
    OutError.Reset();
    return true;
}

bool FSpatialPrevisWorkspaceCodec::Parse(const FString& Json, TSharedPtr<FJsonObject>& OutWorkspace, FString& OutError)
{
    FValue Value;
    if (!FSpatialPrevisProjectCodec::ParseJson(Json, Value, OutError)) return false;
    if (!Type(Value, EJson::Object) || !Value->AsObject().IsValid()) { OutError = TEXT("Workspace: expected object"); return false; }
    const FObject Workspace = Value->AsObject();
    if (!HasField(Workspace, TEXT("format")) && HasField(Workspace, TEXT("schemaVersion")))
        return FromProject(Workspace, OutWorkspace, OutError);
    if (!Validate(Workspace, OutError)) return false;
    OutWorkspace = Workspace;
    return true;
}

bool FSpatialPrevisWorkspaceCodec::Validate(const TSharedPtr<FJsonObject>& Workspace, FString& OutError)
{
    FString Error;
    if (!FValidator(Error).Validate(Workspace)) { OutError = MoveTemp(Error); return false; }
    OutError.Reset();
    return true;
}

bool FSpatialPrevisWorkspaceCodec::Serialize(const TSharedPtr<FJsonObject>& Workspace, FString& OutJson, FString& OutError)
{
    if (!Validate(Workspace, OutError)) return false;
    return FSpatialPrevisProjectCodec::SerializeJson(MakeShared<FJsonValueObject>(Workspace), OutJson, OutError);
}

TArray<FString> FSpatialPrevisWorkspaceCodec::References(const TSharedPtr<FJsonObject>& Record)
{
    TArray<FString> Result;
    if (!Record.IsValid() || !Type(Field(Record, TEXT("kind")), EJson::String)) return Result;
    const FString Kind = Str(Record, TEXT("kind"));
    auto Add = [&](const TCHAR* Name) { if (Type(Field(Record, Name), EJson::String)) Result.Add(Str(Record, Name)); };
    if (Same(Kind, TEXT("asset_instance"))) { Add(TEXT("definitionId")); Add(TEXT("inventoryItemId")); }
    else if (Same(Kind, TEXT("stock_pool")) || Same(Kind, TEXT("inventory_item"))) Add(TEXT("definitionId"));
    else if (Same(Kind, TEXT("assembly")))
    {
        if (Type(Field(Record, TEXT("instanceIds")), EJson::Array))
            for (const FValue& Id : Array(Record, TEXT("instanceIds"))) if (Type(Id, EJson::String)) Result.Add(Id->AsString());
    }
    else if (Same(Kind, TEXT("port"))) Add(TEXT("instanceId"));
    else if (Same(Kind, TEXT("connection"))) { Add(TEXT("sourcePortId")); Add(TEXT("targetPortId")); }
    else if (Same(Kind, TEXT("mechanical_attachment"))) { Add(TEXT("parentInstanceId")); Add(TEXT("childInstanceId")); }
    return Result;
}

TArray<TSharedPtr<FJsonValue>> FSpatialPrevisWorkspaceCodec::ScopedInputs(const TSharedPtr<FJsonObject>& Project, const TArray<FString>& Scope)
{
    FValues Result;
    if (!Project.IsValid() || !Type(Field(Project, TEXT("records")), EJson::Array)) return Result;
    TSet<FExactString> Ids;
    for (const FString& Id : Scope) Ids.Add(FExactString(Id));
    bool Changed = true;
    while (Changed)
    {
        Changed = false;
        for (const FValue& Value : Array(Project, TEXT("records")))
        {
            const FObject& Record = Value->AsObject();
            const FString Id = Str(Record, TEXT("id"));
            const TArray<FString> Refs = References(Record);
            if (Ids.Contains(FExactString(Id)))
            {
                for (const FString& Ref : Refs)
                    if (!Ids.Contains(FExactString(Ref))) { Ids.Add(FExactString(Ref)); Changed = true; }
            }
            else
            {
                const FString Kind = Str(Record, TEXT("kind"));
                if (Same(Kind, TEXT("port")) || Same(Kind, TEXT("connection")) || Same(Kind, TEXT("mechanical_attachment")))
                    for (const FString& Ref : Refs)
                        if (Ids.Contains(FExactString(Ref))) { Ids.Add(FExactString(Id)); Changed = true; break; }
            }
        }
    }
    for (const FValue& Value : Array(Project, TEXT("records")))
        if (Ids.Contains(FExactString(Str(Value->AsObject(), TEXT("id"))))) Result.Add(Value);
    Result.Sort([](const FValue& A, const FValue& B) { return Less(Str(A->AsObject(), TEXT("id")), Str(B->AsObject(), TEXT("id"))); });
    return Result;
}

bool FSpatialPrevisWorkspaceCodec::InputHash(const TSharedPtr<FJsonObject>& Project, const TArray<FString>& Scope,
    const FString& Model, const FString& ModelVersion, FString& OutHash, FString& OutError)
{
    if (!FSpatialPrevisProjectCodec::Validate(Project, OutError)) return false;
    TArray<FString> SortedScope = Scope;
    SortedScope.Sort([](const FString& A, const FString& B) { return Less(A, B); });
    FValues ScopeValues;
    for (const FString& Id : SortedScope) ScopeValues.Add(MakeShared<FJsonValueString>(Id));
    const FObject Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("projectId"), Str(Project, TEXT("projectId")));
    Payload->SetStringField(TEXT("coordinateFrame"), Str(Project, TEXT("coordinateFrame")));
    Payload->SetArrayField(TEXT("scope"), ScopeValues);
    Payload->SetStringField(TEXT("model"), Model);
    Payload->SetStringField(TEXT("modelVersion"), ModelVersion);
    Payload->SetArrayField(TEXT("records"), ScopedInputs(Project, Scope));
    const FString Json = Canonical(MakeShared<FJsonValueObject>(Payload));
    const FTCHARToUTF8 Utf8(*Json, Json.Len());
    uint8 Digest[32];
    Sha256(reinterpret_cast<const uint8*>(Utf8.Get()), static_cast<uint64>(Utf8.Length()), Digest);
    FString Hash;
    for (uint8 Byte : Digest) Hash += FString::Printf(TEXT("%02x"), static_cast<uint32>(Byte));
    OutHash = MoveTemp(Hash);
    OutError.Reset();
    return true;
}
