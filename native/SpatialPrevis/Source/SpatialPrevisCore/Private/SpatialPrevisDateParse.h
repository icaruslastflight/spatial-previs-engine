#pragma once

#include "CoreMinimal.h"
#include <cmath>
#include <cstdint>
#include <ctime>
#include <limits>

// Date.parse validity adapter for the workspace-v1 contract. Parser state machine
// adapted from Node v24.19.0 / V8 13.6.233.17 dateparser{,-inl}.h and dateparser.cc:
// https://github.com/nodejs/node/tree/v24.19.0/deps/v8/src/date
// Keep the license below in redistributed source and binary notices.
// This follows Node's 32-bit Smi bound for legacy timezone arithmetic. Chrome
// builds with pointer compression can reject enormous legacy offsets sooner.
// Local-time clipping at the +/-100,000,000-day boundary depends on OS timezone
// data. Windows uses a calendar-equivalent year outside the CRT's supported range;
// that fallback is not an exact replacement for V8/ICU historical timezone rules.
/*
Copyright 2011 the V8 project authors. All rights reserved.
Copyright 2014, the V8 project authors. All rights reserved.
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above
      copyright notice, this list of conditions and the following
      disclaimer in the documentation and/or other materials provided
      with the distribution.
    * Neither the name of Google Inc. nor the names of its
      contributors may be used to endorse or promote products derived
      from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

namespace SpatialPrevisDateParse
{
namespace Detail
{
template <typename Char> struct StringView
{
    const Char* Data;
    int Length;
    int length() const { return Length; }
    Char operator[](int Index) const { return Data[Index]; }
};
inline bool IsWhiteSpace(uint32_t C)
{
    return C == 0x09 || C == 0x0b || C == 0x0c || C == 0x20 || C == 0xa0 ||
        C == 0x1680 || (C >= 0x2000 && C <= 0x200a) || C == 0x202f ||
        C == 0x205f || C == 0x3000 || C == 0xfeff;
}
inline bool IsWhiteSpaceOrLineTerminator(uint32_t C)
{
    return IsWhiteSpace(C) || C == 0x0a || C == 0x0d || C == 0x2028 || C == 0x2029;
}
inline bool IsDecimalDigit(uint32_t C) { return C >= '0' && C <= '9'; }
inline uint32_t AsciiAlphaToLower(uint32_t C)
{
    return C >= 'A' && C <= 'Z' ? C + ('a' - 'A') : C;
}


class DateParser {
 public:
  enum {
    YEAR,
    MONTH,
    DAY,
    HOUR,
    MINUTE,
    SECOND,
    MILLISECOND,
    UTC_OFFSET,
    OUTPUT_SIZE
  };

  // Parse the string as a date. If parsing succeeds, return true after
  // filling out the output array as follows (all integers are Smis):
  // [0]: year
  // [1]: month (0 = Jan, 1 = Feb, ...)
  // [2]: day
  // [3]: hour
  // [4]: minute
  // [5]: second
  // [6]: millisecond
  // [7]: UTC offset in seconds, or null value if no timezone specified
  // If parsing fails, return false (content of output array is not defined).
  template <typename Char>
  static bool Parse(StringView<Char> str, double* output);

 private:
  // Range testing
  static inline bool Between(int x, int lo, int hi) {
    return static_cast<unsigned>(x - lo) <= static_cast<unsigned>(hi - lo);
  }

  // Indicates a missing value.
  static const int kNone = std::numeric_limits<int>::max();

  // Maximal number of digits used to build the value of a numeral.
  // Remaining digits are ignored.
  static const int kMaxSignificantDigits = 9;

  // InputReader provides basic string parsing and character classification.
  template <typename Char>
  class InputReader {
   public:
    explicit InputReader(StringView<Char> s) : index_(0), buffer_(s) {
      Next();
    }

    int position() { return index_; }

    // Advance to the next character of the string.
    void Next() {
      ch_ = (index_ < buffer_.length()) ? buffer_[index_] : 0;
      index_++;
    }

    // Read a string of digits as an unsigned number. Cap value at
    // kMaxSignificantDigits, but skip remaining digits if the numeral
    // is longer.
    int ReadUnsignedNumeral() {
      int n = 0;
      int i = 0;
      // First, skip leading zeros
      while (ch_ == '0') Next();
      // And then, do the conversion
      while (IsAsciiDigit()) {
        if (i < kMaxSignificantDigits) n = n * 10 + ch_ - '0';
        i++;
        Next();
      }
      return n;
    }

    // Read a word (sequence of chars. >= 'A'), fill the given buffer with a
    // lower-case prefix, and pad any remainder of the buffer with zeroes.
    // Return word length.
    int ReadWord(uint32_t* prefix, int prefix_size) {
      int len;
      for (len = 0; IsAsciiAlphaOrAbove() && !IsWhiteSpaceChar();
           Next(), len++) {
        if (len < prefix_size) prefix[len] = AsciiAlphaToLower(ch_);
      }
      for (int i = len; i < prefix_size; i++) prefix[i] = 0;
      return len;
    }

    // The skip methods return whether they actually skipped something.
    bool Skip(uint32_t c) {
      if (ch_ == c) {
        Next();
        return true;
      }
      return false;
    }

    inline bool SkipWhiteSpace();
    inline bool SkipParentheses();

    // Character testing/classification. Non-ASCII digits are not supported.
    bool Is(uint32_t c) const { return ch_ == c; }
    bool IsEnd() const { return ch_ == 0; }
    bool IsAsciiDigit() const { return IsDecimalDigit(ch_); }
    bool IsAsciiAlphaOrAbove() const { return ch_ >= 'A'; }
    bool IsWhiteSpaceChar() const { return IsWhiteSpace(ch_); }
    bool IsAsciiSign() const { return ch_ == '+' || ch_ == '-'; }

    // Return 1 for '+' and -1 for '-'.
    int GetAsciiSignValue() const { return 44 - static_cast<int>(ch_); }

   private:
    int index_;
    StringView<Char> buffer_;
    uint32_t ch_;
  };

  enum KeywordType {
    INVALID,
    MONTH_NAME,
    TIME_ZONE_NAME,
    TIME_SEPARATOR,
    AM_PM
  };

  struct DateToken {
   public:
    bool IsInvalid() { return tag_ == kInvalidTokenTag; }
    bool IsUnknown() { return tag_ == kUnknownTokenTag; }
    bool IsNumber() { return tag_ == kNumberTag; }
    bool IsSymbol() { return tag_ == kSymbolTag; }
    bool IsWhiteSpace() { return tag_ == kWhiteSpaceTag; }
    bool IsEndOfInput() { return tag_ == kEndOfInputTag; }
    bool IsKeyword() { return tag_ >= kKeywordTagStart; }

    int length() { return length_; }

    int number() {
      return value_;
    }
    KeywordType keyword_type() {
      return static_cast<KeywordType>(tag_);
    }
    int keyword_value() {
      return value_;
    }
    char symbol() {
      return static_cast<char>(value_);
    }
    bool IsSymbol(char symbol) {
      return IsSymbol() && this->symbol() == symbol;
    }
    bool IsKeywordType(KeywordType tag) { return tag_ == tag; }
    bool IsFixedLengthNumber(int length) {
      return IsNumber() && length_ == length;
    }
    bool IsAsciiSign() {
      return tag_ == kSymbolTag && (value_ == '-' || value_ == '+');
    }
    int ascii_sign() {
      return 44 - value_;
    }
    bool IsKeywordZ() {
      return IsKeywordType(TIME_ZONE_NAME) && length_ == 1 && value_ == 0;
    }
    bool IsUnknown(int character) { return IsUnknown() && value_ == character; }
    // Factory functions.
    static DateToken Keyword(KeywordType tag, int value, int length) {
      return DateToken(tag, length, value);
    }
    static DateToken Number(int value, int length) {
      return DateToken(kNumberTag, length, value);
    }
    static DateToken Symbol(char symbol) {
      return DateToken(kSymbolTag, 1, symbol);
    }
    static DateToken EndOfInput() { return DateToken(kEndOfInputTag, 0, -1); }
    static DateToken WhiteSpace(int length) {
      return DateToken(kWhiteSpaceTag, length, -1);
    }
    static DateToken Unknown() { return DateToken(kUnknownTokenTag, 1, -1); }
    static DateToken Invalid() { return DateToken(kInvalidTokenTag, 0, -1); }

   private:
    enum TagType {
      kInvalidTokenTag = -6,
      kUnknownTokenTag = -5,
      kWhiteSpaceTag = -4,
      kNumberTag = -3,
      kSymbolTag = -2,
      kEndOfInputTag = -1,
      kKeywordTagStart = 0
    };
    DateToken(int tag, int length, int value)
        : tag_(tag), length_(length), value_(value) {}

    int tag_;
    int length_;  // Number of characters.
    int value_;
  };

  template <typename Char>
  class DateStringTokenizer {
   public:
    explicit DateStringTokenizer(InputReader<Char>* in)
        : in_(in), next_(Scan()) {}
    DateToken Next() {
      DateToken result = next_;
      next_ = Scan();
      return result;
    }

    DateToken Peek() { return next_; }
    bool SkipSymbol(char symbol) {
      if (next_.IsSymbol(symbol)) {
        next_ = Scan();
        return true;
      }
      return false;
    }

   private:
    DateToken Scan();

    InputReader<Char>* in_;
    DateToken next_;
  };

  static int ReadMilliseconds(DateToken number);

  // KeywordTable maps names of months, time zones, am/pm to numbers.
  class KeywordTable {
   public:
    // Look up a word in the keyword table and return an index.
    // 'pre' contains a prefix of the word, zero-padded to size kPrefixLength
    // and 'len' is the word length.
    static int Lookup(const uint32_t* pre, int len);
    // Get the type of the keyword at index i.
    static KeywordType GetType(int i) {
      return static_cast<KeywordType>(array[i][kTypeOffset]);
    }
    // Get the value of the keyword at index i.
    static int GetValue(int i) { return array[i][kValueOffset]; }

    static const int kPrefixLength = 3;
    static const int kTypeOffset = kPrefixLength;
    static const int kValueOffset = kTypeOffset + 1;
    static const int kEntrySize = kValueOffset + 1;
    static const int8_t array[][kEntrySize];
  };

  class TimeZoneComposer {
   public:
    TimeZoneComposer() : sign_(kNone), hour_(kNone), minute_(kNone) {}
    void Set(int offset_in_hours) {
      sign_ = offset_in_hours < 0 ? -1 : 1;
      hour_ = offset_in_hours * sign_;
      minute_ = 0;
    }
    void SetSign(int sign) { sign_ = sign < 0 ? -1 : 1; }
    void SetAbsoluteHour(int hour) { hour_ = hour; }
    void SetAbsoluteMinute(int minute) { minute_ = minute; }
    bool IsExpecting(int n) const {
      return hour_ != kNone && minute_ == kNone && TimeComposer::IsMinute(n);
    }
    bool IsUTC() const { return hour_ == 0 && minute_ == 0; }
    bool Write(double* output);
    bool IsEmpty() { return hour_ == kNone; }

   private:
    int sign_;
    int hour_;
    int minute_;
  };

  class TimeComposer {
   public:
    TimeComposer() : index_(0), hour_offset_(kNone) {}
    bool IsEmpty() const { return index_ == 0; }
    bool IsExpecting(int n) const {
      return (index_ == 1 && IsMinute(n)) || (index_ == 2 && IsSecond(n)) ||
             (index_ == 3 && IsMillisecond(n));
    }
    bool Add(int n) {
      return index_ < kSize ? (comp_[index_++] = n, true) : false;
    }
    bool AddFinal(int n) {
      if (!Add(n)) return false;
      while (index_ < kSize) comp_[index_++] = 0;
      return true;
    }
    void SetHourOffset(int n) { hour_offset_ = n; }
    bool Write(double* output);

    static bool IsMinute(int x) { return Between(x, 0, 59); }
    static bool IsHour(int x) { return Between(x, 0, 23); }
    static bool IsSecond(int x) { return Between(x, 0, 59); }

   private:
    static bool IsHour12(int x) { return Between(x, 0, 12); }
    static bool IsMillisecond(int x) { return Between(x, 0, 999); }

    static const int kSize = 4;
    int comp_[kSize];
    int index_;
    int hour_offset_;
  };

  class DayComposer {
   public:
    DayComposer() : index_(0), named_month_(kNone), is_iso_date_(false) {}
    bool IsEmpty() const { return index_ == 0; }
    bool Add(int n) {
      if (index_ < kSize) {
        comp_[index_] = n;
        index_++;
        return true;
      }
      return false;
    }
    void SetNamedMonth(int n) { named_month_ = n; }
    bool Write(double* output);
    void set_iso_date() { is_iso_date_ = true; }
    static bool IsMonth(int x) { return Between(x, 1, 12); }
    static bool IsDay(int x) { return Between(x, 1, 31); }

   private:
    static const int kSize = 3;
    int comp_[kSize];
    int index_;
    int named_month_;
    // If set, ensures that data is always parsed in year-month-date order.
    bool is_iso_date_;
  };

  // Tries to parse an ES5 Date Time String. Returns the next token
  // to continue with in the legacy date string parser. If parsing is
  // complete, returns DateToken::EndOfInput(). If terminally unsuccessful,
  // returns DateToken::Invalid(). Otherwise parsing continues in the
  // legacy parser.
  template <typename Char>
  static DateParser::DateToken ParseES5DateTime(
      DateStringTokenizer<Char>* scanner, DayComposer* day, TimeComposer* time,
      TimeZoneComposer* tz);
};




inline bool DateParser::DayComposer::Write(double* output) {
  if (index_ < 1) return false;
  // Day and month defaults to 1.
  while (index_ < kSize) {
    comp_[index_++] = 1;
  }

  int year = 0;  // Default year is 0 (=> 2000) for KJS compatibility.
  int month = kNone;
  int day = kNone;

  if (named_month_ == kNone) {
    if (is_iso_date_ || (index_ == 3 && !IsDay(comp_[0]))) {
      // YMD
      year = comp_[0];
      month = comp_[1];
      day = comp_[2];
    } else {
      // MD(Y)
      month = comp_[0];
      day = comp_[1];
      if (index_ == 3) year = comp_[2];
    }
  } else {
    month = named_month_;
    if (index_ == 1) {
      // MD or DM
      day = comp_[0];
    } else if (!IsDay(comp_[0])) {
      // YMD, MYD, or YDM
      year = comp_[0];
      day = comp_[1];
    } else {
      // DMY, MDY, or DYM
      day = comp_[0];
      year = comp_[1];
    }
  }

  if (!is_iso_date_) {
    if (Between(year, 0, 49))
      year += 2000;
    else if (Between(year, 50, 99))
      year += 1900;
  }

  if (!(year >= -1073741824 && year <= 1073741823) || !IsMonth(month) || !IsDay(day)) return false;

  output[YEAR] = year;
  output[MONTH] = month - 1;  // 0-based
  output[DAY] = day;
  return true;
}

inline bool DateParser::TimeComposer::Write(double* output) {
  // All time slots default to 0
  while (index_ < kSize) {
    comp_[index_++] = 0;
  }

  int& hour = comp_[0];
  int& minute = comp_[1];
  int& second = comp_[2];
  int& millisecond = comp_[3];

  if (hour_offset_ != kNone) {
    if (!IsHour12(hour)) return false;
    hour %= 12;
    hour += hour_offset_;
  }

  if (!IsHour(hour) || !IsMinute(minute) || !IsSecond(second) ||
      !IsMillisecond(millisecond)) {
    // A 24th hour is allowed if minutes, seconds, and milliseconds are 0
    if (hour != 24 || minute != 0 || second != 0 || millisecond != 0) {
      return false;
    }
  }

  output[HOUR] = hour;
  output[MINUTE] = minute;
  output[SECOND] = second;
  output[MILLISECOND] = millisecond;
  return true;
}

inline bool DateParser::TimeZoneComposer::Write(double* output) {
  if (sign_ != kNone) {
    if (hour_ == kNone) hour_ = 0;
    if (minute_ == kNone) minute_ = 0;
    // Avoid signed integer overflow (undefined behavior) by doing unsigned
    // arithmetic.
    unsigned total_seconds_unsigned = hour_ * 3600U + minute_ * 60U;
    if (total_seconds_unsigned > 2147483647U) return false;
    int total_seconds = static_cast<int>(total_seconds_unsigned);
    if (sign_ < 0) {
      total_seconds = -total_seconds;
    }
    
    output[UTC_OFFSET] = total_seconds;
  } else {
    output[UTC_OFFSET] = std::numeric_limits<double>::quiet_NaN();
  }
  return true;
}

inline const int8_t
    DateParser::KeywordTable::array[][DateParser::KeywordTable::kEntrySize] = {
        {'j', 'a', 'n', DateParser::MONTH_NAME, 1},
        {'f', 'e', 'b', DateParser::MONTH_NAME, 2},
        {'m', 'a', 'r', DateParser::MONTH_NAME, 3},
        {'a', 'p', 'r', DateParser::MONTH_NAME, 4},
        {'m', 'a', 'y', DateParser::MONTH_NAME, 5},
        {'j', 'u', 'n', DateParser::MONTH_NAME, 6},
        {'j', 'u', 'l', DateParser::MONTH_NAME, 7},
        {'a', 'u', 'g', DateParser::MONTH_NAME, 8},
        {'s', 'e', 'p', DateParser::MONTH_NAME, 9},
        {'o', 'c', 't', DateParser::MONTH_NAME, 10},
        {'n', 'o', 'v', DateParser::MONTH_NAME, 11},
        {'d', 'e', 'c', DateParser::MONTH_NAME, 12},
        {'a', 'm', '\0', DateParser::AM_PM, 0},
        {'p', 'm', '\0', DateParser::AM_PM, 12},
        {'u', 't', '\0', DateParser::TIME_ZONE_NAME, 0},
        {'u', 't', 'c', DateParser::TIME_ZONE_NAME, 0},
        {'z', '\0', '\0', DateParser::TIME_ZONE_NAME, 0},
        {'g', 'm', 't', DateParser::TIME_ZONE_NAME, 0},
        {'c', 'd', 't', DateParser::TIME_ZONE_NAME, -5},
        {'c', 's', 't', DateParser::TIME_ZONE_NAME, -6},
        {'e', 'd', 't', DateParser::TIME_ZONE_NAME, -4},
        {'e', 's', 't', DateParser::TIME_ZONE_NAME, -5},
        {'m', 'd', 't', DateParser::TIME_ZONE_NAME, -6},
        {'m', 's', 't', DateParser::TIME_ZONE_NAME, -7},
        {'p', 'd', 't', DateParser::TIME_ZONE_NAME, -7},
        {'p', 's', 't', DateParser::TIME_ZONE_NAME, -8},
        {'t', '\0', '\0', DateParser::TIME_SEPARATOR, 0},
        {'\0', '\0', '\0', DateParser::INVALID, 0},
};

// We could use perfect hashing here, but this is not a bottleneck.
inline int DateParser::KeywordTable::Lookup(const uint32_t* pre, int len) {
  int i;
  for (i = 0; array[i][kTypeOffset] != INVALID; i++) {
    int j = 0;
    while (j < kPrefixLength && pre[j] == static_cast<uint32_t>(array[i][j])) {
      j++;
    }
    // Check if we have a match and the length is legal.
    // Word longer than keyword is only allowed for month names.
    if (j == kPrefixLength &&
        (len <= kPrefixLength || array[i][kTypeOffset] == MONTH_NAME)) {
      return i;
    }
  }
  return i;
}

inline int DateParser::ReadMilliseconds(DateToken token) {
  // Read first three significant digits of the original numeral,
  // as inferred from the value and the number of digits.
  // I.e., use the number of digits to see if there were
  // leading zeros.
  int number = token.number();
  int length = token.length();
  if (length < 3) {
    // Less than three digits. Multiply to put most significant digit
    // in hundreds position.
    if (length == 1) {
      number *= 100;
    } else if (length == 2) {
      number *= 10;
    }
  } else if (length > 3) {
    if (length > kMaxSignificantDigits) length = kMaxSignificantDigits;
    // More than three digits. Divide by 10^(length - 3) to get three
    // most significant digits.
    int factor = 1;
    do {  // factor won't overflow.
      factor *= 10;
      length--;
    } while (length > 3);
    number /= factor;
  }
  return number;
}




template <typename Char>
inline bool DateParser::Parse(StringView<Char> str, double* out) {
  InputReader<Char> in(str);
  DateStringTokenizer<Char> scanner(&in);
  TimeZoneComposer tz;
  TimeComposer time;
  DayComposer day;

  // Specification:
  // Accept ES5 ISO 8601 date-time-strings or legacy dates compatible
  // with Safari.
  // ES5 ISO 8601 dates:
  //   [('-'|'+')yy]yyyy[-MM[-DD]][THH:mm[:ss[.sss]][Z|(+|-)hh:mm]]
  //   where yyyy is in the range 0000..9999 and
  //         +/-yyyyyy is in the range -999999..+999999 -
  //           but -000000 is invalid (year zero must be positive),
  //         MM is in the range 01..12,
  //         DD is in the range 01..31,
  //         MM and DD defaults to 01 if missing,,
  //         HH is generally in the range 00..23, but can be 24 if mm, ss
  //           and sss are zero (or missing), representing midnight at the
  //           end of a day,
  //         mm and ss are in the range 00..59,
  //         sss is in the range 000..999,
  //         hh is in the range 00..23,
  //         mm, ss, and sss default to 00 if missing, and
  //         date-only forms without a zone use UTC; date-time forms use local time.
  //  Extensions:
  //   We also allow sss to have more or less than three digits (but at
  //   least one).
  //   We allow hh:mm to be specified as hhmm.
  // Legacy dates:
  //  Any unrecognized word before the first number is ignored.
  //  Parenthesized text is ignored.
  //  An unsigned number followed by ':' is a time value, and is
  //  added to the TimeComposer. A number followed by '::' adds a second
  //  zero as well. A number followed by '.' is also a time and must be
  //  followed by milliseconds.
  //  Any other number is a date component and is added to DayComposer.
  //  A month name (or really: any word having the same first three letters
  //  as a month name) is recorded as a named month in the Day composer.
  //  A word recognizable as a time-zone is recorded as such, as is
  //  '(+|-)(hhmm|hh:)'.
  //  Legacy dates don't allow extra signs ('+' or '-') or umatched ')'
  //  after a number has been read (before the first number, any garbage
  //  is allowed).
  // Intersection of the two:
  //  A string that matches both formats (e.g. 1970-01-01) will be
  //  parsed as an ES5 date-time string - which means it will default
  //  to UTC time-zone. That's unavoidable if following the ES5
  //  specification.
  //  After a valid "T" has been read while scanning an ES5 datetime string,
  //  the input can no longer be a valid legacy date, since the "T" is a
  //  garbage string after a number has been read.

  // First try getting as far as possible with as ES5 Date Time String.
  DateToken next_unhandled_token = ParseES5DateTime(&scanner, &day, &time, &tz);
  if (next_unhandled_token.IsInvalid()) return false;
  bool has_read_number = !day.IsEmpty();
  // If there's anything left, continue with the legacy parser.
  for (DateToken token = next_unhandled_token; !token.IsEndOfInput();
       token = scanner.Next()) {
    if (token.IsNumber()) {
      has_read_number = true;
      int n = token.number();
      if (scanner.SkipSymbol(':')) {
        if (scanner.SkipSymbol(':')) {
          // n + "::"
          if (!time.IsEmpty()) return false;
          time.Add(n);
          time.Add(0);
        } else {
          // n + ":"
          if (!time.Add(n)) return false;
          if (scanner.Peek().IsSymbol('.')) scanner.Next();
        }
      } else if (scanner.SkipSymbol('.') && time.IsExpecting(n)) {
        time.Add(n);
        if (!scanner.Peek().IsNumber()) return false;
        int ms = ReadMilliseconds(scanner.Next());
        if (ms < 0) return false;
        time.AddFinal(ms);
      } else if (tz.IsExpecting(n)) {
        tz.SetAbsoluteMinute(n);
      } else if (time.IsExpecting(n)) {
        time.AddFinal(n);
        // Require end, white space, "Z", "+" or "-" immediately after
        // finalizing time.
        DateToken peek = scanner.Peek();
        if (!peek.IsEndOfInput() && !peek.IsWhiteSpace() &&
            !peek.IsKeywordZ() && !peek.IsAsciiSign())
          return false;
      } else {
        if (!day.Add(n)) return false;
        scanner.SkipSymbol('-');
      }
    } else if (token.IsKeyword()) {
      // Parse a "word" (sequence of chars. >= 'A').
      KeywordType type = token.keyword_type();
      int value = token.keyword_value();
      if (type == AM_PM && !time.IsEmpty()) {
        time.SetHourOffset(value);
      } else if (type == MONTH_NAME) {
        day.SetNamedMonth(value);
        scanner.SkipSymbol('-');
      } else if (type == TIME_ZONE_NAME && has_read_number) {
        tz.Set(value);
      } else {
        // Garbage words are illegal if a number has been read.
        if (has_read_number) return false;
        // The first number has to be separated from garbage words by
        // whitespace or other separators.
        if (scanner.Peek().IsNumber()) return false;
      }
    } else if (token.IsAsciiSign() && (tz.IsUTC() || !time.IsEmpty())) {
      // Parse UTC offset (only after UTC or time).
      tz.SetSign(token.ascii_sign());
      // The following number may be empty.
      int n = 0;
      int length = 0;
      if (scanner.Peek().IsNumber()) {
        DateToken next_token = scanner.Next();
        length = next_token.length();
        n = next_token.number();
      }
      has_read_number = true;

      if (scanner.Peek().IsSymbol(':')) {
        tz.SetAbsoluteHour(n);
        // TODO(littledan): Use minutes as part of timezone?
        tz.SetAbsoluteMinute(kNone);
      } else if (length == 2 || length == 1) {
        // Handle time zones like GMT-8
        tz.SetAbsoluteHour(n);
        tz.SetAbsoluteMinute(0);
      } else if (length == 4 || length == 3) {
        // Looks like the hhmm format
        tz.SetAbsoluteHour(n / 100);
        tz.SetAbsoluteMinute(n % 100);
      } else {
        // No need to accept time zones like GMT-12345
        return false;
      }
    } else if ((token.IsAsciiSign() || token.IsSymbol(')')) &&
               has_read_number) {
      // Extra sign or ')' is illegal if a number has been read.
      return false;
    } else {
      // Ignore other characters and whitespace.
    }
  }

  bool success = day.Write(out) && time.Write(out) && tz.Write(out);


  return success;
}

template <typename CharType>
DateParser::DateToken DateParser::DateStringTokenizer<CharType>::Scan() {
  int pre_pos = in_->position();
  if (in_->IsEnd()) return DateToken::EndOfInput();
  if (in_->IsAsciiDigit()) {
    int n = in_->ReadUnsignedNumeral();
    int length = in_->position() - pre_pos;
    return DateToken::Number(n, length);
  }
  if (in_->Skip(':')) return DateToken::Symbol(':');
  if (in_->Skip('-')) return DateToken::Symbol('-');
  if (in_->Skip('+')) return DateToken::Symbol('+');
  if (in_->Skip('.')) return DateToken::Symbol('.');
  if (in_->Skip(')')) return DateToken::Symbol(')');
  if (in_->IsAsciiAlphaOrAbove() && !in_->IsWhiteSpaceChar()) {
    uint32_t buffer[3] = {0, 0, 0};
    int length = in_->ReadWord(buffer, 3);
    int index = KeywordTable::Lookup(buffer, length);
    return DateToken::Keyword(KeywordTable::GetType(index),
                              KeywordTable::GetValue(index), length);
  }
  if (in_->SkipWhiteSpace()) {
    return DateToken::WhiteSpace(in_->position() - pre_pos);
  }
  if (in_->SkipParentheses()) {
    return DateToken::Unknown();
  }
  in_->Next();
  return DateToken::Unknown();
}

template <typename Char>
inline bool DateParser::InputReader<Char>::SkipWhiteSpace() {
  if (IsWhiteSpaceOrLineTerminator(ch_)) {
    Next();
    return true;
  }
  return false;
}

template <typename Char>
inline bool DateParser::InputReader<Char>::SkipParentheses() {
  if (ch_ != '(') return false;
  int balance = 0;
  do {
    if (ch_ == ')')
      --balance;
    else if (ch_ == '(')
      ++balance;
    Next();
  } while (balance > 0 && ch_);
  return true;
}

template <typename Char>
DateParser::DateToken DateParser::ParseES5DateTime(
    DateStringTokenizer<Char>* scanner, DayComposer* day, TimeComposer* time,
    TimeZoneComposer* tz) {

  // Parse mandatory date string: [('-'|'+')yy]yyyy['-'MM['-'DD]]
  if (scanner->Peek().IsAsciiSign()) {
    // Keep the sign token, so we can pass it back to the legacy
    // parser if we don't use it.
    DateToken sign_token = scanner->Next();
    if (!scanner->Peek().IsFixedLengthNumber(6)) return sign_token;
    int sign = sign_token.ascii_sign();
    int year = scanner->Next().number();
    if (sign < 0 && year == 0) return sign_token;
    day->Add(sign * year);
  } else if (scanner->Peek().IsFixedLengthNumber(4)) {
    day->Add(scanner->Next().number());
  } else {
    return scanner->Next();
  }
  if (scanner->SkipSymbol('-')) {
    if (!scanner->Peek().IsFixedLengthNumber(2) ||
        !DayComposer::IsMonth(scanner->Peek().number()))
      return scanner->Next();
    day->Add(scanner->Next().number());
    if (scanner->SkipSymbol('-')) {
      if (!scanner->Peek().IsFixedLengthNumber(2) ||
          !DayComposer::IsDay(scanner->Peek().number()))
        return scanner->Next();
      day->Add(scanner->Next().number());
    }
  }
  // Check for optional time string: 'T'HH':'mm[':'ss['.'sss]]Z
  if (!scanner->Peek().IsKeywordType(TIME_SEPARATOR)) {
    if (!scanner->Peek().IsEndOfInput()) return scanner->Next();
  } else {
    // ES5 Date Time String time part is present.
    scanner->Next();
    if (!scanner->Peek().IsFixedLengthNumber(2) ||
        !Between(scanner->Peek().number(), 0, 24)) {
      return DateToken::Invalid();
    }
    // Allow 24:00[:00[.000]], but no other time starting with 24.
    bool hour_is_24 = (scanner->Peek().number() == 24);
    time->Add(scanner->Next().number());
    if (!scanner->SkipSymbol(':')) return DateToken::Invalid();
    if (!scanner->Peek().IsFixedLengthNumber(2) ||
        !TimeComposer::IsMinute(scanner->Peek().number()) ||
        (hour_is_24 && scanner->Peek().number() > 0)) {
      return DateToken::Invalid();
    }
    time->Add(scanner->Next().number());
    if (scanner->SkipSymbol(':')) {
      if (!scanner->Peek().IsFixedLengthNumber(2) ||
          !TimeComposer::IsSecond(scanner->Peek().number()) ||
          (hour_is_24 && scanner->Peek().number() > 0)) {
        return DateToken::Invalid();
      }
      time->Add(scanner->Next().number());
      if (scanner->SkipSymbol('.')) {
        if (!scanner->Peek().IsNumber() ||
            (hour_is_24 && scanner->Peek().number() > 0)) {
          return DateToken::Invalid();
        }
        // Allow more or less than the mandated three digits.
        time->Add(ReadMilliseconds(scanner->Next()));
      }
    }
    // Check for optional timezone designation: 'Z' | ('+'|'-')hh':'mm
    if (scanner->Peek().IsKeywordZ()) {
      scanner->Next();
      tz->Set(0);
    } else if (scanner->Peek().IsSymbol('+') || scanner->Peek().IsSymbol('-')) {
      tz->SetSign(scanner->Next().symbol() == '+' ? 1 : -1);
      if (scanner->Peek().IsFixedLengthNumber(4)) {
        // hhmm extension syntax.
        int hourmin = scanner->Next().number();
        int hour = hourmin / 100;
        int min = hourmin % 100;
        if (!TimeComposer::IsHour(hour) || !TimeComposer::IsMinute(min)) {
          return DateToken::Invalid();
        }
        tz->SetAbsoluteHour(hour);
        tz->SetAbsoluteMinute(min);
      } else {
        // hh:mm standard syntax.
        if (!scanner->Peek().IsFixedLengthNumber(2) ||
            !TimeComposer::IsHour(scanner->Peek().number())) {
          return DateToken::Invalid();
        }
        tz->SetAbsoluteHour(scanner->Next().number());
        if (!scanner->SkipSymbol(':')) return DateToken::Invalid();
        if (!scanner->Peek().IsFixedLengthNumber(2) ||
            !TimeComposer::IsMinute(scanner->Peek().number())) {
          return DateToken::Invalid();
        }
        tz->SetAbsoluteMinute(scanner->Next().number());
      }
    }
    if (!scanner->Peek().IsEndOfInput()) return DateToken::Invalid();
  }
  // Successfully parsed ES5 Date Time String.
  // ES#sec-date-time-string-format Date Time String Format
  // "When the time zone offset is absent, date-only forms are interpreted
  //  as a UTC time and date-time forms are interpreted as a local time."
  if (tz->IsEmpty() && time->IsEmpty()) {
    tz->Set(0);
  }
  day->set_iso_date();
  return DateToken::EndOfInput();
}


// Gregorian day arithmetic supports astronomical years and day rollovers without
// going through FDateTime's narrower year range. All intermediates fit int64.
inline int64_t FloorDivide(int64_t N, int64_t D)
{
    const int64_t Q = N / D;
    return Q - (N % D < 0 ? 1 : 0);
}
inline int64_t DaysFromCivil(int Year, int Month, int Day)
{
    const int64_t Y = static_cast<int64_t>(Year) - (Month <= 2 ? 1 : 0);
    const int64_t Era = FloorDivide(Y, 400);
    const int64_t Yoe = Y - Era * 400;
    const int64_t Mp = Month + (Month > 2 ? -3 : 9);
    const int64_t Doy = (153 * Mp + 2) / 5 + Day - 1;
    return Era * 146097 + Yoe * 365 + Yoe / 4 - Yoe / 100 + Doy - 719468;
}
inline int EquivalentYear(int Year)
{
    const int Weekday = static_cast<int>((DaysFromCivil(Year, 1, 1) % 7 + 11) % 7);
    const bool Leap = Year % 4 == 0 && (Year % 100 != 0 || Year % 400 == 0);
    const int Recent = (Leap ? 1956 : 1967) + (Weekday * 12) % 28;
    return 2008 + (Recent + 84 - 2008) % 28;
}
inline bool ClipLocal(double* Out, double CivilMs)
{
    constexpr double Limit = 8640000000000000.0;
    // Timezone offsets cannot move ordinary dates across TimeClip. Avoid relying
    // on limited CRT date ranges except for the narrow boundary where it matters.
    if (std::abs(CivilMs) < Limit - 3 * 86400000.0) return true;
    if (std::abs(CivilMs) > Limit + 3 * 86400000.0) return false;
    int Year = static_cast<int>(Out[DateParser::YEAR]);
    const int Month = static_cast<int>(Out[DateParser::MONTH]) + 1;
    const int Day = static_cast<int>(Out[DateParser::DAY]);
    bool Equivalent = false;
#if defined(_WIN32)
    // Windows CRT cannot represent the astronomical years at the Date boundary.
    Year = EquivalentYear(Year);
    Equivalent = true;
#endif
    std::tm Local{};
    Local.tm_year = Year - 1900;
    Local.tm_mon = Month - 1;
    Local.tm_mday = Day;
    Local.tm_hour = static_cast<int>(Out[DateParser::HOUR]);
    Local.tm_min = static_cast<int>(Out[DateParser::MINUTE]);
    Local.tm_sec = static_cast<int>(Out[DateParser::SECOND]);
    Local.tm_isdst = -1;
    const std::time_t Utc = std::mktime(&Local);
    if (Utc == static_cast<std::time_t>(-1)) return false;
    const double LocalAsUtc = static_cast<double>(DaysFromCivil(Year, Month, Day)) * 86400000.0 +
        Out[DateParser::HOUR] * 3600000.0 + Out[DateParser::MINUTE] * 60000.0 +
        Out[DateParser::SECOND] * 1000.0;
    const double Result = Equivalent ? CivilMs + static_cast<double>(Utc) * 1000.0 - LocalAsUtc :
        static_cast<double>(Utc) * 1000.0 + Out[DateParser::MILLISECOND];
    return std::abs(Result) <= Limit;
}
} // namespace Detail

inline bool IsFinite(const FString& Value)
{
    using Detail::DateParser;
    double Out[DateParser::OUTPUT_SIZE];
    if (!DateParser::Parse(Detail::StringView<TCHAR>{*Value, Value.Len()}, Out)) return false;
    const int Year = static_cast<int>(Out[DateParser::YEAR]);
    // V8 MakeDay first rejects years beyond this range, even if a huge legacy
    // timezone offset could otherwise bring the result back inside TimeClip.
    if (Year < -1000000 || Year > 1000000) return false;
    const int Month = static_cast<int>(Out[DateParser::MONTH]) + 1;
    const int Day = static_cast<int>(Out[DateParser::DAY]);
    double Milliseconds = static_cast<double>(Detail::DaysFromCivil(Year, Month, Day)) * 86400000.0 +
        Out[DateParser::HOUR] * 3600000.0 + Out[DateParser::MINUTE] * 60000.0 +
        Out[DateParser::SECOND] * 1000.0 + Out[DateParser::MILLISECOND];
    if (std::isnan(Out[DateParser::UTC_OFFSET])) return Detail::ClipLocal(Out, Milliseconds);
    Milliseconds -= Out[DateParser::UTC_OFFSET] * 1000.0;
    return std::isfinite(Milliseconds) && std::abs(Milliseconds) <= 8640000000000000.0;
}
} // namespace SpatialPrevisDateParse
