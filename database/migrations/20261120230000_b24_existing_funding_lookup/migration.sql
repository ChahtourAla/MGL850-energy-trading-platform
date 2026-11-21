CREATE FUNCTION "b24_find_local_funding"(rid UUID,gid UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x RECORD;
BEGIN
 IF session_user<>'b24_funder' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'funding role not authorized' USING ERRCODE='42501'; END IF;
 SELECT f.id,f."amountBaseUnits"::text amount,f."sessionId",s."senderAddress",s."senderNonce"::text sender_nonce,s."grantId",e.state,e."txHash" INTO x FROM public."B24FundingSubmission" s JOIN public."B24FundingOperation" f ON f.id=s."operationId" LEFT JOIN LATERAL (SELECT state,"txHash" FROM public."B24OperationEvent" WHERE "fundingOperationId"=f.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE s."reservationId"=rid;
 IF x.id IS NULL THEN RETURN NULL; END IF;
 IF x."grantId"<>gid THEN RAISE EXCEPTION 'conflicting funding grant'; END IF;
 RETURN jsonb_build_object('id',x.id,'amountBaseUnits',x.amount,'sessionId',x."sessionId",'senderAddress',x."senderAddress",'senderNonce',x.sender_nonce,'grantId',x."grantId",'state',x.state,'txHash',x."txHash",'reused',true);
END $$;
REVOKE ALL ON FUNCTION "b24_find_local_funding"(UUID,UUID) FROM PUBLIC;
