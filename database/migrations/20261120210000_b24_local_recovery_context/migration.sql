-- Read-only recovery context. It never authorizes a new transfer.
CREATE FUNCTION "b24_local_recovery_context"(kind TEXT,oid UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result JSONB;
BEGIN
 IF current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') OR NOT ((kind='FUNDING' AND session_user='b24_funder') OR (kind='ALLOWANCE' AND session_user='b24_allowance')) THEN RAISE EXCEPTION 'recovery role not authorized' USING ERRCODE='42501'; END IF;
 IF kind='FUNDING' THEN
  SELECT jsonb_build_object('operationId',f.id,'reservationId',r.id,'sessionId',x."sessionId",'sender',x."senderAddress",'senderNonce',x."senderNonce"::text,'amountBaseUnits',f."amountBaseUnits"::text,'buyer',r."buyerAddress",'token',d."tokenAddress",'contract',d."contractAddress",'state',coalesce(e.state,'PREPARED'),'txHash',e."txHash") INTO result
  FROM public."B24FundingSubmission" x JOIN public."B24FundingOperation" f ON f.id=x."operationId" JOIN public."B24AuthorizationReservation" r ON r.id=x."reservationId" JOIN public."B24Deployment" d ON d.id=r."deploymentId" LEFT JOIN LATERAL (SELECT state,"txHash" FROM public."B24OperationEvent" WHERE "fundingOperationId"=f.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE x."operationId"=oid;
 ELSE
  SELECT jsonb_build_object('operationId',a.id,'reservationId',r.id,'sessionId',x."sessionId",'sender',r."buyerAddress",'senderNonce',x."senderNonce"::text,'amountBaseUnits',a."amountBaseUnits"::text,'buyer',r."buyerAddress",'token',d."tokenAddress",'contract',d."contractAddress",'state',coalesce(e.state,'PREPARED'),'txHash',e."txHash") INTO result
  FROM public."B24AllowanceSubmission" x JOIN public."B24AllowanceOperation" a ON a.id=x."operationId" JOIN public."B24AuthorizationReservation" r ON r.id=x."reservationId" JOIN public."B24Deployment" d ON d.id=r."deploymentId" LEFT JOIN LATERAL (SELECT state,"txHash" FROM public."B24OperationEvent" WHERE "allowanceOperationId"=a.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE x."operationId"=oid;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION "b24_local_recovery_context"(TEXT,UUID) FROM PUBLIC;
