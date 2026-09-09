use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use minicbor::data::{Tag, Type};
use minicbor::{Decoder, Encoder};
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::WorldError;

/// The context-value encoding selected by the first SQLite schema.
pub const SQLITE_CONTEXT_CODEC: &str = "workflow-cbor-v1";

const MAX_CODEC_DEPTH: usize = 128;
pub const MAX_SAFE_CONTEXT_INTEGER: i64 = 9_007_199_254_740_991;
pub const MIN_SAFE_CONTEXT_INTEGER: i64 = -MAX_SAFE_CONTEXT_INTEGER;
const CBOR_TIMESTAMP_TAG: u64 = 1;
const CBOR_UINT8_ARRAY_TAG: u64 = 64;

/// An owned, language-neutral value tree accepted at World context boundaries.
///
/// Bindings convert host-language values into this type before leaving their
/// runtime thread. Cycles are rejected there and shared references become
/// independent, equal subtrees; reference identity is intentionally not part
/// of the World contract.
#[derive(Clone, Debug, PartialEq)]
pub enum ContextValue {
    Null,
    Bool(bool),
    Integer(i64),
    Float(f64),
    String(String),
    Bytes(Vec<u8>),
    Array(Vec<Self>),
    Object(BTreeMap<String, Self>),
}

impl ContextValue {
    #[must_use]
    pub const fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }
}

impl Serialize for ContextValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Integer(value) => serializer.serialize_i64(*value),
            Self::Float(value) => serializer.serialize_f64(*value),
            Self::String(value) => serializer.serialize_str(value),
            Self::Bytes(value) => serializer.serialize_bytes(value),
            Self::Array(values) => {
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    sequence.serialize_element(value)?;
                }
                sequence.end()
            }
            Self::Object(values) => {
                let mut map = serializer.serialize_map(Some(values.len()))?;
                for (key, value) in values {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for ContextValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(ContextValueVisitor)
    }
}

struct ContextValueVisitor;

impl<'de> Visitor<'de> for ContextValueVisitor {
    type Value = ContextValue;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a portable context value")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(ContextValue::Null)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(ContextValue::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(ContextValue::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        require_safe_integer(value)
            .map(ContextValue::Integer)
            .map_err(E::custom)
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        let value = i64::try_from(value).map_err(E::custom)?;
        self.visit_i64(value)
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        require_finite_float(value)
            .map(ContextValue::Float)
            .map_err(E::custom)
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(ContextValue::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(ContextValue::String(value))
    }

    fn visit_bytes<E>(self, value: &[u8]) -> Result<Self::Value, E> {
        Ok(ContextValue::Bytes(value.to_vec()))
    }

    fn visit_byte_buf<E>(self, value: Vec<u8>) -> Result<Self::Value, E> {
        Ok(ContextValue::Bytes(value))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0));
        while let Some(value) = sequence.next_element()? {
            values.push(value);
        }
        Ok(ContextValue::Array(values))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, ContextValue>()? {
            if values.insert(key.clone(), value).is_some() {
                return Err(serde::de::Error::custom(format!(
                    "duplicate context object key {key:?}"
                )));
            }
        }
        Ok(ContextValue::Object(values))
    }
}

/// A language-neutral projection of values read from legacy persistence.
///
/// `Undefined` and `TimestampMs` retain distinctions found in existing
/// `cbor-x` data, while `Bytes` also maps into the new context profile. A
/// typed protocol model decides which legacy variants it accepts.
#[derive(Clone, Debug, PartialEq)]
pub enum PersistedValue {
    Undefined,
    Null,
    Bool(bool),
    Integer(i128),
    Float(f64),
    String(String),
    Bytes(Vec<u8>),
    TimestampMs(i64),
    Array(Vec<Self>),
    Object(BTreeMap<String, Self>),
}

/// Encode a context tree as deterministic standard CBOR.
pub fn encode_context_value(value: &ContextValue) -> Result<Vec<u8>, WorldError> {
    let mut encoder = Encoder::new(Vec::new());
    encode_context_value_into(&mut encoder, value, 0)?;
    Ok(encoder.into_writer())
}

/// Decode the standard CBOR profile used for context-value BLOB columns.
pub fn decode_context_value(bytes: &[u8]) -> Result<ContextValue, WorldError> {
    let value = decode_cbor(bytes, "context CBOR")?;
    ContextValue::try_from(value)
}

/// Decode legacy JSON/JSONB/text persistence into a language-neutral value.
///
/// Plain PostgreSQL JSONB and JSON-stringified errors retain ordinary JSON
/// semantics. This also intentionally matches the filesystem World's reviver:
/// any object containing the exact `__type: "Uint8Array"` and string `data`
/// pair becomes bytes, even if the object has additional properties.
pub fn decode_legacy_json_text(text: &str) -> Result<PersistedValue, WorldError> {
    let value: Value =
        serde_json::from_str(text).map_err(codec_error("decode legacy JSON/text"))?;
    project_legacy_json(value, 0)
}

/// Decode the standard CBOR forms emitted by the repository's current
/// `cbor-x` helpers: maps, arrays, primitives, undefined, epoch timestamps,
/// and tag-64 `Uint8Array` values.
pub fn decode_legacy_cbor_x(bytes: &[u8]) -> Result<PersistedValue, WorldError> {
    decode_cbor(bytes, "legacy cbor-x data")
}

fn decode_cbor(bytes: &[u8], label: &str) -> Result<PersistedValue, WorldError> {
    let mut decoder = Decoder::new(bytes);
    let value = decode_cbor_value(&mut decoder, 0)?;
    if decoder.position() != bytes.len() {
        return Err(WorldError::persisted_data(format!(
            "decode {label}: trailing bytes after the first value"
        )));
    }
    Ok(value)
}

impl TryFrom<Value> for ContextValue {
    type Error = WorldError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        context_from_json(value, 0)
    }
}

impl TryFrom<PersistedValue> for ContextValue {
    type Error = WorldError;

    fn try_from(value: PersistedValue) -> Result<Self, Self::Error> {
        context_from_persisted(value, 0)
    }
}

fn context_from_json(value: Value, depth: usize) -> Result<ContextValue, WorldError> {
    require_depth(depth, "context JSON")?;
    match value {
        Value::Null => Ok(ContextValue::Null),
        Value::Bool(value) => Ok(ContextValue::Bool(value)),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                return require_safe_integer(value).map(ContextValue::Integer);
            }
            if let Some(value) = value.as_u64() {
                let value = i64::try_from(value).map_err(|_| {
                    WorldError::persisted_data("context integer exceeds the interoperable range")
                })?;
                return require_safe_integer(value).map(ContextValue::Integer);
            }
            let value = value
                .as_f64()
                .ok_or_else(|| WorldError::persisted_data("invalid context number"))?;
            require_finite_float(value).map(ContextValue::Float)
        }
        Value::String(value) => Ok(ContextValue::String(value)),
        Value::Array(values) => values
            .into_iter()
            .map(|value| context_from_json(value, depth + 1))
            .collect::<Result<Vec<_>, _>>()
            .map(ContextValue::Array),
        Value::Object(values) => values
            .into_iter()
            .map(|(key, value)| context_from_json(value, depth + 1).map(|value| (key, value)))
            .collect::<Result<BTreeMap<_, _>, _>>()
            .map(ContextValue::Object),
    }
}

fn context_from_persisted(value: PersistedValue, depth: usize) -> Result<ContextValue, WorldError> {
    require_depth(depth, "context CBOR")?;
    match value {
        PersistedValue::Null => Ok(ContextValue::Null),
        PersistedValue::Bool(value) => Ok(ContextValue::Bool(value)),
        PersistedValue::Integer(value) => {
            let value = i64::try_from(value).map_err(|_| {
                WorldError::persisted_data("context integer exceeds the interoperable range")
            })?;
            require_safe_integer(value).map(ContextValue::Integer)
        }
        PersistedValue::Float(value) => require_finite_float(value).map(ContextValue::Float),
        PersistedValue::String(value) => Ok(ContextValue::String(value)),
        PersistedValue::Bytes(value) => Ok(ContextValue::Bytes(value)),
        PersistedValue::Array(values) => values
            .into_iter()
            .map(|value| context_from_persisted(value, depth + 1))
            .collect::<Result<Vec<_>, _>>()
            .map(ContextValue::Array),
        PersistedValue::Object(values) => values
            .into_iter()
            .map(|(key, value)| context_from_persisted(value, depth + 1).map(|value| (key, value)))
            .collect::<Result<BTreeMap<_, _>, _>>()
            .map(ContextValue::Object),
        PersistedValue::Undefined => Err(WorldError::persisted_data(
            "context CBOR contains unsupported undefined",
        )),
        PersistedValue::TimestampMs(_) => Err(WorldError::persisted_data(
            "context CBOR contains unsupported timestamp",
        )),
    }
}

fn require_safe_integer(value: i64) -> Result<i64, WorldError> {
    if !(MIN_SAFE_CONTEXT_INTEGER..=MAX_SAFE_CONTEXT_INTEGER).contains(&value) {
        return Err(WorldError::persisted_data(format!(
            "context integer exceeds the interoperable range: {value}"
        )));
    }
    Ok(value)
}

fn require_finite_float(value: f64) -> Result<f64, WorldError> {
    if !value.is_finite() {
        return Err(WorldError::persisted_data(
            "context floating-point value must be finite",
        ));
    }
    Ok(value)
}

fn to_u64_length(length: usize) -> Result<u64, WorldError> {
    u64::try_from(length)
        .map_err(|_| WorldError::persisted_data("context collection length exceeds u64"))
}

fn project_legacy_json(value: Value, depth: usize) -> Result<PersistedValue, WorldError> {
    require_depth(depth, "legacy JSON/text")?;
    match value {
        Value::Null => Ok(PersistedValue::Null),
        Value::Bool(value) => Ok(PersistedValue::Bool(value)),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(PersistedValue::Integer(i128::from(value)))
            } else if let Some(value) = value.as_u64() {
                Ok(PersistedValue::Integer(i128::from(value)))
            } else {
                value
                    .as_f64()
                    .map(PersistedValue::Float)
                    .ok_or_else(|| WorldError::persisted_data("invalid legacy JSON number"))
            }
        }
        Value::String(value) => Ok(PersistedValue::String(value)),
        Value::Array(values) => values
            .into_iter()
            .map(|value| project_legacy_json(value, depth + 1))
            .collect::<Result<Vec<_>, _>>()
            .map(PersistedValue::Array),
        Value::Object(values) => {
            if matches!(values.get("__type"), Some(Value::String(kind)) if kind == "Uint8Array")
                && let Some(Value::String(data)) = values.get("data")
            {
                return BASE64
                    .decode(data)
                    .map(PersistedValue::Bytes)
                    .map_err(codec_error("decode legacy local Uint8Array"));
            }
            values
                .into_iter()
                .map(|(key, value)| project_legacy_json(value, depth + 1).map(|value| (key, value)))
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map(PersistedValue::Object)
        }
    }
}

fn encode_context_value_into(
    encoder: &mut Encoder<Vec<u8>>,
    value: &ContextValue,
    depth: usize,
) -> Result<(), WorldError> {
    require_depth(depth, "context CBOR")?;
    match value {
        ContextValue::Null => encoder.null(),
        ContextValue::Bool(value) => encoder.bool(*value),
        ContextValue::Integer(value) => {
            require_safe_integer(*value)?;
            encoder.i64(*value)
        }
        ContextValue::Float(value) => {
            require_finite_float(*value)?;
            encoder.f64(*value)
        }
        ContextValue::String(value) => encoder.str(value),
        ContextValue::Bytes(value) => encoder
            .tag(Tag::new(CBOR_UINT8_ARRAY_TAG))
            .and_then(|encoder| encoder.bytes(value)),
        ContextValue::Array(values) => {
            encoder
                .array(to_u64_length(values.len())?)
                .map_err(codec_error("encode context CBOR"))?;
            for value in values {
                encode_context_value_into(encoder, value, depth + 1)?;
            }
            return Ok(());
        }
        ContextValue::Object(values) => {
            encoder
                .map(to_u64_length(values.len())?)
                .map_err(codec_error("encode context CBOR"))?;
            for (key, value) in values {
                encoder
                    .str(key)
                    .map_err(codec_error("encode context CBOR"))?;
                encode_context_value_into(encoder, value, depth + 1)?;
            }
            return Ok(());
        }
    }
    .map(|_| ())
    .map_err(codec_error("encode context CBOR"))
}

fn decode_cbor_value(
    decoder: &mut Decoder<'_>,
    depth: usize,
) -> Result<PersistedValue, WorldError> {
    require_depth(depth, "legacy cbor-x data")?;
    let data_type = decoder
        .datatype()
        .map_err(codec_error("inspect legacy cbor-x data"))?;
    match data_type {
        Type::Bool => decoder
            .bool()
            .map(PersistedValue::Bool)
            .map_err(codec_error("decode legacy cbor-x boolean")),
        Type::Null => {
            decoder
                .null()
                .map_err(codec_error("decode legacy cbor-x null"))?;
            Ok(PersistedValue::Null)
        }
        Type::Undefined => {
            decoder
                .undefined()
                .map_err(codec_error("decode legacy cbor-x undefined"))?;
            Ok(PersistedValue::Undefined)
        }
        Type::U8 | Type::U16 | Type::U32 | Type::U64 => decoder
            .u64()
            .map(|value| PersistedValue::Integer(i128::from(value)))
            .map_err(codec_error("decode legacy cbor-x integer")),
        Type::I8 | Type::I16 | Type::I32 | Type::I64 | Type::Int => decoder
            .int()
            .map(|value| PersistedValue::Integer(i128::from(value)))
            .map_err(codec_error("decode legacy cbor-x integer")),
        Type::F16 | Type::F32 | Type::F64 => decoder
            .f64()
            .map(PersistedValue::Float)
            .map_err(codec_error("decode legacy cbor-x float")),
        Type::Bytes | Type::BytesIndef => decode_cbor_bytes(decoder).map(PersistedValue::Bytes),
        Type::String | Type::StringIndef => decode_cbor_string(decoder).map(PersistedValue::String),
        Type::Array | Type::ArrayIndef => decode_cbor_array(decoder, depth + 1),
        Type::Map | Type::MapIndef => decode_cbor_object(decoder, depth + 1),
        Type::Tag => decode_cbor_tag(decoder, depth + 1),
        Type::Simple | Type::Break | Type::Unknown(_) => Err(WorldError::persisted_data(format!(
            "unsupported legacy cbor-x data type {data_type}"
        ))),
    }
}

fn decode_cbor_bytes(decoder: &mut Decoder<'_>) -> Result<Vec<u8>, WorldError> {
    let chunks = decoder
        .bytes_iter()
        .map_err(codec_error("decode legacy cbor-x bytes"))?;
    let mut bytes = Vec::new();
    for chunk in chunks {
        bytes.extend_from_slice(chunk.map_err(codec_error("decode legacy cbor-x bytes"))?);
    }
    Ok(bytes)
}

fn decode_cbor_string(decoder: &mut Decoder<'_>) -> Result<String, WorldError> {
    let chunks = decoder
        .str_iter()
        .map_err(codec_error("decode legacy cbor-x string"))?;
    let mut text = String::new();
    for chunk in chunks {
        text.push_str(chunk.map_err(codec_error("decode legacy cbor-x string"))?);
    }
    Ok(text)
}

fn decode_cbor_array(
    decoder: &mut Decoder<'_>,
    depth: usize,
) -> Result<PersistedValue, WorldError> {
    let length = decoder
        .array()
        .map_err(codec_error("decode legacy cbor-x array"))?;
    let mut values = Vec::new();
    match length {
        Some(length) => {
            for _ in 0..length {
                values.push(decode_cbor_value(decoder, depth)?);
            }
        }
        None => {
            while decoder
                .datatype()
                .map_err(codec_error("decode legacy cbor-x array"))?
                != Type::Break
            {
                values.push(decode_cbor_value(decoder, depth)?);
            }
            consume_break(decoder);
        }
    }
    Ok(PersistedValue::Array(values))
}

fn decode_cbor_object(
    decoder: &mut Decoder<'_>,
    depth: usize,
) -> Result<PersistedValue, WorldError> {
    let length = decoder
        .map()
        .map_err(codec_error("decode legacy cbor-x object"))?;
    let mut values = BTreeMap::new();
    match length {
        Some(length) => {
            for _ in 0..length {
                decode_cbor_object_entry(decoder, depth, &mut values)?;
            }
        }
        None => {
            while decoder
                .datatype()
                .map_err(codec_error("decode legacy cbor-x object"))?
                != Type::Break
            {
                decode_cbor_object_entry(decoder, depth, &mut values)?;
            }
            consume_break(decoder);
        }
    }
    Ok(PersistedValue::Object(values))
}

fn decode_cbor_object_entry(
    decoder: &mut Decoder<'_>,
    depth: usize,
    values: &mut BTreeMap<String, PersistedValue>,
) -> Result<(), WorldError> {
    let key = decode_cbor_string(decoder)?;
    let value = decode_cbor_value(decoder, depth)?;
    if values.insert(key.clone(), value).is_some() {
        return Err(WorldError::persisted_data(format!(
            "decode legacy cbor-x object: duplicate key {key:?}"
        )));
    }
    Ok(())
}

fn decode_cbor_tag(decoder: &mut Decoder<'_>, depth: usize) -> Result<PersistedValue, WorldError> {
    let tag = decoder
        .tag()
        .map_err(codec_error("decode legacy cbor-x tag"))?
        .as_u64();
    match tag {
        CBOR_TIMESTAMP_TAG => decode_cbor_timestamp(decoder),
        CBOR_UINT8_ARRAY_TAG => match decode_cbor_value(decoder, depth)? {
            PersistedValue::Bytes(bytes) => Ok(PersistedValue::Bytes(bytes)),
            _ => Err(WorldError::persisted_data(
                "decode legacy cbor-x Uint8Array: tag 64 must wrap bytes",
            )),
        },
        _ => Err(WorldError::persisted_data(format!(
            "unsupported legacy cbor-x tag {tag}"
        ))),
    }
}

fn decode_cbor_timestamp(decoder: &mut Decoder<'_>) -> Result<PersistedValue, WorldError> {
    let seconds = match decoder
        .datatype()
        .map_err(codec_error("inspect legacy cbor-x timestamp"))?
    {
        Type::U8 | Type::U16 | Type::U32 | Type::U64 => decoder
            .u64()
            .map(|value| value as f64)
            .map_err(codec_error("decode legacy cbor-x timestamp"))?,
        Type::I8 | Type::I16 | Type::I32 | Type::I64 | Type::Int => decoder
            .int()
            .map(|value| i128::from(value) as f64)
            .map_err(codec_error("decode legacy cbor-x timestamp"))?,
        Type::F16 | Type::F32 | Type::F64 => decoder
            .f64()
            .map_err(codec_error("decode legacy cbor-x timestamp"))?,
        other => {
            return Err(WorldError::persisted_data(format!(
                "decode legacy cbor-x timestamp: expected a number, found {other}"
            )));
        }
    };
    let milliseconds = seconds * 1_000.0;
    if !milliseconds.is_finite() || milliseconds < i64::MIN as f64 || milliseconds > i64::MAX as f64
    {
        return Err(WorldError::persisted_data(
            "decode legacy cbor-x timestamp: value is outside the millisecond range",
        ));
    }
    Ok(PersistedValue::TimestampMs(milliseconds.round() as i64))
}

fn consume_break(decoder: &mut Decoder<'_>) {
    decoder.set_position(decoder.position() + 1);
}

fn require_depth(depth: usize, label: &str) -> Result<(), WorldError> {
    if depth > MAX_CODEC_DEPTH {
        return Err(WorldError::persisted_data(format!(
            "decode {label}: nesting exceeds {MAX_CODEC_DEPTH} levels"
        )));
    }
    Ok(())
}

fn codec_error<E>(operation: &'static str) -> impl FnOnce(E) -> WorldError
where
    E: std::fmt::Display,
{
    move |error| WorldError::persisted_data(format!("{operation}: {error}"))
}
