-- Receipt verification must bind the reserved sender and nonce.
-- Expose only the immutable context needed by the local receipt verifier.
CREATE OR REPLACE FUNCTION "b24_local_receipt_context"(kind TEXT, oid UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result JSONB;
BEGIN
 IF session_user<>'b24_receipt_verifier' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'receipt verifier not authorized' USING ERRCODE='42501'; END IF;
 IF kind='FUNDING' THEN
  SELECT jsonb_build_object('operationId',f.id,'reservationId',r.id,'sessionId',f."sessionId",'amountBaseUnits',f."amountBaseUnits"::text,'buyer',r."buyerAddress",'token',d."tokenAddress",'contract',d."contractAddress",'txHash',e."txHash",'state',e.state,'deploymentStatus',d.status,'chainId',d."chainId",'sender',x."senderAddress",'senderNonce',x."senderNonce"::text) INTO result
  FROM public."B24FundingOperation" f LEFT JOIN public."B24FundingSubmission" x ON x."operationId"=f.id JOIN public."B24AuthorizationReservation" r ON r.id=f."reservationId" JOIN public."B24Deployment" d ON d.id=r."deploymentId" LEFT JOIN LATERAL (SELECT state,"txHash" FROM public."B24OperationEvent" WHERE "fundingOperationId"=f.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE f.id=oid;
 ELSIF kind='ALLOWANCE' THEN
  SELECT jsonb_build_object('operationId',a.id,'reservationId',r.id,'sessionId',a."sessionId",'amountBaseUnits',a."amountBaseUnits"::text,'buyer',r."buyerAddress",'token',d."tokenAddress",'contract',d."contractAddress",'txHash',e."txHash",'state',e.state,'deploymentStatus',d.status,'chainId',d."chainId",'sender',r."buyerAddress",'senderNonce',x."senderNonce"::text) INTO result
  FROM public."B24AllowanceOperation" a LEFT JOIN public."B24AllowanceSubmission" x ON x."operationId"=a.id JOIN public."B24AuthorizationReservation" r ON r.id=a."reservationId" JOIN public."B24Deployment" d ON d.id=r."deploymentId" LEFT JOIN LATERAL (SELECT state,"txHash" FROM public."B24OperationEvent" WHERE "allowanceOperationId"=a.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE a.id=oid;
 ELSE RAISE EXCEPTION 'unknown operation type'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION "b24_local_receipt_context"(TEXT,UUID) FROM PUBLIC;
