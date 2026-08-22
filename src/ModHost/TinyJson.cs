using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Gambonanza.ModHost
{
    /// <summary>
    /// A small JSON reader, used for texture pack manifests.
    ///
    /// Unity ships JsonUtility, and it was the obvious choice - but it is the
    /// Inspector's serializer wearing a JSON hat, and it quietly declined to
    /// fill in arrays of the manifest's nested override classes: strings came
    /// back, `textures[]` and `texts[]` came back empty, and nothing said why.
    /// A file format that mod authors will hand-edit and pass around deserves a
    /// reader that either works or says what is wrong with the file.
    ///
    /// The game's own SimpleJSON (Blukulele.Core.JSON) would do, but reaching
    /// into game types by reflection to read our OWN file would make a game
    /// update able to break texture packs for no reason.
    ///
    /// Produces plain CLR values: Dictionary&lt;string, object&gt;, List&lt;object&gt;,
    /// string, double, bool, null.
    /// </summary>
    internal static class TinyJson
    {
        /// <summary>
        /// How deep a document may nest. A recursive parser meeting a
        /// deliberately deep one overflows the stack, and .NET cannot catch a
        /// StackOverflowException - the process just dies, taking the game with
        /// it. No real manifest nests past three levels.
        /// </summary>
        private const int MaxDepth = 64;

        public static object Parse(string text)
        {
            if (text == null) throw new FormatException("empty document");
            int index = 0;
            SkipWhitespace(text, ref index);
            var value = ParseValue(text, ref index, 0);
            SkipWhitespace(text, ref index);
            if (index != text.Length) throw new FormatException($"trailing characters at position {index}");
            return value;
        }

        // -- typed helpers, so callers never cast by hand ---------------------

        public static Dictionary<string, object> AsObject(object value) => value as Dictionary<string, object>;

        public static List<object> AsList(object value) => value as List<object>;

        public static string Str(Dictionary<string, object> obj, string key, string fallback = null)
        {
            if (obj == null || !obj.TryGetValue(key, out var value) || value == null) return fallback;
            if (value is string s) return s;
            if (value is double d) return d.ToString(CultureInfo.InvariantCulture);
            if (value is bool b) return b ? "true" : "false";
            return fallback;
        }

        public static int Int(Dictionary<string, object> obj, string key, int fallback = 0)
        {
            if (obj == null || !obj.TryGetValue(key, out var value)) return fallback;
            if (value is double d) return (int)Math.Round(d);
            if (value is string s && double.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed)) return (int)Math.Round(parsed);
            return fallback;
        }

        /// <summary>The array at `key`, or an empty list - callers never null-check.</summary>
        public static List<object> Array(Dictionary<string, object> obj, string key)
        {
            if (obj != null && obj.TryGetValue(key, out var value) && value is List<object> list) return list;
            return new List<object>();
        }

        // -- the parser -------------------------------------------------------

        private static object ParseValue(string text, ref int index, int depth)
        {
            if (index >= text.Length) throw new FormatException("document ended early");
            if (depth > MaxDepth) throw new FormatException($"nested more than {MaxDepth} levels deep at position {index}");
            switch (text[index])
            {
                case '{': return ParseObject(text, ref index, depth);
                case '[': return ParseArray(text, ref index, depth);
                case '"': return ParseString(text, ref index);
                case 't': Expect(text, ref index, "true"); return true;
                case 'f': Expect(text, ref index, "false"); return false;
                case 'n': Expect(text, ref index, "null"); return null;
                default: return ParseNumber(text, ref index);
            }
        }

        private static Dictionary<string, object> ParseObject(string text, ref int index, int depth)
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            index++; // {
            SkipWhitespace(text, ref index);
            if (index < text.Length && text[index] == '}') { index++; return result; }

            while (true)
            {
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != '"') throw new FormatException($"expected a key at position {index}");
                var key = ParseString(text, ref index);
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != ':') throw new FormatException($"expected ':' at position {index}");
                index++;
                SkipWhitespace(text, ref index);
                result[key] = ParseValue(text, ref index, depth + 1);
                SkipWhitespace(text, ref index);
                if (index >= text.Length) throw new FormatException("object was never closed");
                if (text[index] == ',') { index++; continue; }
                if (text[index] == '}') { index++; return result; }
                throw new FormatException($"expected ',' or '}}' at position {index}");
            }
        }

        private static List<object> ParseArray(string text, ref int index, int depth)
        {
            var result = new List<object>();
            index++; // [
            SkipWhitespace(text, ref index);
            if (index < text.Length && text[index] == ']') { index++; return result; }

            while (true)
            {
                SkipWhitespace(text, ref index);
                result.Add(ParseValue(text, ref index, depth + 1));
                SkipWhitespace(text, ref index);
                if (index >= text.Length) throw new FormatException("array was never closed");
                if (text[index] == ',') { index++; continue; }
                if (text[index] == ']') { index++; return result; }
                throw new FormatException($"expected ',' or ']' at position {index}");
            }
        }

        private static string ParseString(string text, ref int index)
        {
            index++; // opening quote
            var sb = new StringBuilder();
            while (true)
            {
                if (index >= text.Length) throw new FormatException("string was never closed");
                var c = text[index++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }

                if (index >= text.Length) throw new FormatException("escape sequence was cut short");
                var escape = text[index++];
                switch (escape)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (index + 4 > text.Length) throw new FormatException("\\u escape was cut short");
                        // Surrogate pairs arrive as two \u escapes and append in
                        // order, so emoji and CJK survive the round trip.
                        sb.Append((char)ushort.Parse(text.Substring(index, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        index += 4;
                        break;
                    default: throw new FormatException($"unknown escape \\{escape} at position {index - 1}");
                }
            }
        }

        private static double ParseNumber(string text, ref int index)
        {
            int start = index;
            if (index < text.Length && (text[index] == '-' || text[index] == '+')) index++;
            while (index < text.Length && (char.IsDigit(text[index]) || text[index] == '.'
                || text[index] == 'e' || text[index] == 'E' || text[index] == '-' || text[index] == '+')) index++;
            var slice = text.Substring(start, index - start);
            if (!double.TryParse(slice, NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
                throw new FormatException($"'{slice}' is not a number (position {start})");
            return value;
        }

        private static void Expect(string text, ref int index, string literal)
        {
            if (index + literal.Length > text.Length || string.CompareOrdinal(text, index, literal, 0, literal.Length) != 0)
                throw new FormatException($"expected '{literal}' at position {index}");
            index += literal.Length;
        }

        private static void SkipWhitespace(string text, ref int index)
        {
            while (index < text.Length && char.IsWhiteSpace(text[index])) index++;
        }
    }
}
