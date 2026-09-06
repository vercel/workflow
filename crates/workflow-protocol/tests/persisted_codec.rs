use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Deserialize;
use serde_json::Value;
use workflow_protocol::{
    ContextValue, MAX_SAFE_CONTEXT_INTEGER, PersistedValue, SQLITE_CONTEXT_CODEC,
    decode_context_value, decode_legacy_cbor_x, decode_legacy_json_text, encode_context_value,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedCodecFixture {
    fixture_version: u32,
    name: String,
    new_sqlite: NewCborVector,
    legacy_json_text: JsonVectors,
    legacy_cbor_x: CborVectors,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewCborVector {
    format: String,
    value: Value,
    encoded: FixtureBytes,
}

#[derive(Debug, Deserialize)]
struct JsonVectors {
    format: String,
    vectors: Vec<NamedJsonVector>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamedJsonVector {
    name: String,
    value: Value,
    encoded_text: String,
}

#[derive(Debug, Deserialize)]
struct CborVectors {
    format: String,
    vectors: Vec<CborVector>,
}

#[derive(Debug, Deserialize)]
struct CborVector {
    name: String,
    value: Value,
    encoded: FixtureBytes,
}

#[derive(Debug, Deserialize)]
struct FixtureBytes {
    #[serde(rename = "$bytes")]
    base64: String,
}

// @lat: [[rust-portability#Language-Neutral World Contract#Persisted Codec]]
#[test]
fn executes_the_shared_persisted_codec_vectors() {
    let fixture = load_fixture();
    assert_eq!(fixture.fixture_version, 1);
    assert_eq!(fixture.name, "persisted-codec-compatibility");

    assert_eq!(fixture.new_sqlite.format, SQLITE_CONTEXT_CODEC);
    let expected = BASE64
        .decode(&fixture.new_sqlite.encoded.base64)
        .expect("new SQLite fixture bytes");
    let value = ContextValue::try_from(project_fixture_value(&fixture.new_sqlite.value))
        .expect("new SQLite fixture context");
    let encoded = encode_context_value(&value).expect("encode SQLite context CBOR");
    assert_eq!(encoded, expected);
    assert_eq!(
        decode_context_value(&expected).expect("decode SQLite context CBOR"),
        value
    );

    assert_eq!(fixture.legacy_json_text.format, "json-text-v1");
    for vector in fixture.legacy_json_text.vectors {
        let decoded = decode_legacy_json_text(&vector.encoded_text)
            .unwrap_or_else(|error| panic!("failed to decode {}: {error}", vector.name));
        assert_eq!(
            decoded,
            project_fixture_value(&vector.value),
            "{}",
            vector.name
        );
    }

    assert_eq!(fixture.legacy_cbor_x.format, "cbor-x-v1");
    for vector in fixture.legacy_cbor_x.vectors {
        let bytes = BASE64
            .decode(&vector.encoded.base64)
            .unwrap_or_else(|error| panic!("invalid fixture bytes for {}: {error}", vector.name));
        let actual = decode_legacy_cbor_x(&bytes)
            .unwrap_or_else(|error| panic!("failed to decode {}: {error}", vector.name));
        assert_eq!(
            actual,
            project_fixture_value(&vector.value),
            "{}",
            vector.name
        );
    }
}

#[test]
fn rejects_ambiguous_or_unsupported_legacy_cbor() {
    let fixture = load_fixture();
    let mut trailing = BASE64
        .decode(&fixture.legacy_cbor_x.vectors[0].encoded.base64)
        .expect("fixture bytes");
    trailing.push(0);
    assert!(decode_legacy_cbor_x(&trailing).is_err());

    // Tag 42 is not one of the cbor-x forms selected for compatibility.
    assert!(decode_legacy_cbor_x(&[0xd8, 0x2a, 0xf6]).is_err());
    // Persisted extensible objects require string keys.
    assert!(decode_legacy_cbor_x(&[0xa1, 0x01, 0x02]).is_err());
}

#[test]
fn context_codec_rejects_values_outside_the_portable_profile() {
    assert!(encode_context_value(&ContextValue::Integer(MAX_SAFE_CONTEXT_INTEGER + 1)).is_err());
    assert!(encode_context_value(&ContextValue::Float(f64::NAN)).is_err());
    assert!(decode_context_value(&[0xf7]).is_err());
}

fn load_fixture() -> PersistedCodecFixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/world-contract/v1/persisted-codec.json");
    let bytes = fs::read(path).expect("read persisted codec fixture");
    serde_json::from_slice(&bytes).expect("parse persisted codec fixture")
}

fn project_fixture_value(value: &Value) -> PersistedValue {
    match value {
        Value::Null => PersistedValue::Null,
        Value::Bool(value) => PersistedValue::Bool(*value),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                PersistedValue::Integer(i128::from(value))
            } else if let Some(value) = value.as_u64() {
                PersistedValue::Integer(i128::from(value))
            } else {
                PersistedValue::Float(value.as_f64().expect("fixture float"))
            }
        }
        Value::String(value) => PersistedValue::String(value.clone()),
        Value::Array(values) => {
            PersistedValue::Array(values.iter().map(project_fixture_value).collect())
        }
        Value::Object(values) => {
            if values.len() == 1 {
                if let Some(Value::String(value)) = values.get("$bytes") {
                    return PersistedValue::Bytes(BASE64.decode(value).expect("fixture bytes"));
                }
                if matches!(values.get("$undefined"), Some(Value::Bool(true))) {
                    return PersistedValue::Undefined;
                }
                if let Some(Value::Number(value)) = values.get("$timestampMs") {
                    return PersistedValue::TimestampMs(
                        value.as_i64().expect("fixture timestamp milliseconds"),
                    );
                }
            }
            PersistedValue::Object(
                values
                    .iter()
                    .map(|(key, value)| (key.clone(), project_fixture_value(value)))
                    .collect::<BTreeMap<_, _>>(),
            )
        }
    }
}
