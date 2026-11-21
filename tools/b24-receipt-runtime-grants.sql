-- Grant only to a separately authenticated, trusted local receipt verifier.
GRANT USAGE ON SCHEMA public,b22_guard TO b24_receipt_verifier;
GRANT SELECT ON b22_guard.marker TO b24_receipt_verifier;
GRANT EXECUTE ON FUNCTION "b24_record_local_receipt"(TEXT,UUID,TEXT,TEXT,BIGINT,INTEGER) TO b24_receipt_verifier;
GRANT EXECUTE ON FUNCTION "b24_local_receipt_context"(TEXT,UUID) TO b24_receipt_verifier;
