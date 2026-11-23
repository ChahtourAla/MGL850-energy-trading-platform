// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {AccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

contract EnergyTradingDirectSettlementHalfEven is AccessControl, Pausable, ReentrancyGuard, EIP712 {
  using SafeERC20 for IERC20;
  bytes32 public constant OPERATOR_ROLE = keccak256('OPERATOR_ROLE');
  bytes32 public constant PAUSER_ROLE = keccak256('PAUSER_ROLE');
  bytes32 public constant SETTLEMENT_TYPEHASH = keccak256(
    'Settlement(address token,bytes32 marketId,bytes32 snapshotHash,bytes32 planCommitment,bytes32 allocationId,address buyer,address seller,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce,uint256 deadline)'
  );
  uint256 private constant MAX_DB = 9223372036854775807;
  bytes32 public constant HALF_EVEN_POLICY_ID = keccak256('b28-teusd-half-even-1');
  IERC20 public immutable paymentToken;
  mapping(bytes32 => bool) public executedSettlements;
  mapping(bytes32 => bool) public paidAllocations;
  mapping(address => mapping(uint256 => bool)) public usedNonces;
  mapping(bytes32 => bytes32) public marketPlans;
  mapping(bytes32 => bytes32) public marketSnapshots;
  struct Settlement {
    address token;
    bytes32 marketId;
    bytes32 snapshotHash;
    bytes32 planCommitment;
    bytes32 allocationId;
    address buyer;
    address seller;
    uint256 quantityWh;
    uint256 unitPriceMicrousdPerKwh;
    uint256 amountBaseUnits;
    bytes32 algorithmId;
    bytes32 pricingPolicyId;
    uint256 nonce;
    uint256 deadline;
  }
  error InvalidConfiguration();
  error InvalidTerms();
  error InvalidAmount();
  error InvalidSignature();
  error AuthorizationExpired();
  error Replay();
  error ConflictingPlan();
  error UnexpectedTokenBalance();
  event EnergyPaymentSettled(
    bytes32 indexed settlementId,
    bytes32 indexed marketId,
    bytes32 indexed allocationId,
    bytes32 snapshotHash,
    bytes32 planCommitment,
    address buyer,
    address seller,
    address token,
    uint256 quantityWh,
    uint256 unitPriceMicrousdPerKwh,
    uint256 amountBaseUnits,
    bytes32 algorithmId,
    bytes32 pricingPolicyId,
    uint256 nonce
  );
  constructor(
    address token,
    address admin,
    address operator,
    address pauser
  ) EIP712('MGL850 Energy Settlement', '1') {
    if (
      token == address(0) ||
      token.code.length == 0 ||
      admin == address(0) ||
      operator == address(0) ||
      pauser == address(0) ||
      admin == operator ||
      admin == pauser ||
      operator == pauser
    ) revert InvalidConfiguration();
    try IERC20Metadata(token).decimals() returns (uint8 d) {
      if (d != 6) revert InvalidConfiguration();
    } catch {
      revert InvalidConfiguration();
    }
    paymentToken = IERC20(token);
    _grantRole(DEFAULT_ADMIN_ROLE, admin);
    _grantRole(OPERATOR_ROLE, operator);
    _grantRole(PAUSER_ROLE, pauser);
  }
  function pause() external onlyRole(PAUSER_ROLE) {
    _pause();
  }
  function unpause() external onlyRole(PAUSER_ROLE) {
    _unpause();
  }
  function settlementId(Settlement calldata s) public view returns (bytes32) {
    return _hashTypedDataV4(keccak256(abi.encode(SETTLEMENT_TYPEHASH, s)));
  }
  /**
   * Keep orchestration small: Solidity's legacy code generator otherwise
   * exhausts stack slots when validating and transferring a 14-field tuple.
   * The EIP-712 type, public ABI, accounting checks and event remain unchanged.
   */
  function settle(
    Settlement calldata s,
    bytes calldata signature
  ) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
    _validateTermsAndAmount(s);
    bytes32 id = settlementId(s);
    _verifyBuyerAuthorization(s, signature, id);
    _executeExactTokenTransfer(s, id);
    _emitSettlement(s, id);
  }

  function _validateTermsAndAmount(Settlement calldata s) private view {
    if (
      s.token != address(paymentToken) ||
      s.buyer == address(0) ||
      s.seller == address(0) ||
      s.buyer == s.seller ||
      s.buyer == address(this) ||
      s.seller == address(this) ||
      s.marketId == bytes32(0) ||
      s.snapshotHash == bytes32(0) ||
      s.planCommitment == bytes32(0) ||
      s.allocationId == bytes32(0) ||
      s.algorithmId == bytes32(0) ||
      s.pricingPolicyId == bytes32(0)
    ) revert InvalidTerms();
    if (
      s.quantityWh == 0 ||
      s.unitPriceMicrousdPerKwh == 0 ||
      s.quantityWh > MAX_DB ||
      s.unitPriceMicrousdPerKwh > MAX_DB ||
      s.amountBaseUnits == 0 ||
      s.amountBaseUnits > MAX_DB
    ) revert InvalidAmount();

    uint256 product = s.quantityWh * s.unitPriceMicrousdPerKwh;
    uint256 floorAmount = product / 1000;
    uint256 fractional = product % 1000;
    uint256 exactRounded = floorAmount + (
      (fractional > 500 || (fractional == 500 && floorAmount % 2 == 1)) ? 1 : 0
    );
    if (s.pricingPolicyId != HALF_EVEN_POLICY_ID || exactRounded != s.amountBaseUnits)
      revert InvalidAmount();
  }

  function _verifyBuyerAuthorization(
    Settlement calldata s,
    bytes calldata signature,
    bytes32 id
  ) private view {
    if (block.timestamp > s.deadline) revert AuthorizationExpired();
    if (executedSettlements[id] || paidAllocations[s.allocationId] || usedNonces[s.buyer][s.nonce])
      revert Replay();
    bytes32 plan = marketPlans[s.marketId];
    if (
      plan != bytes32(0) &&
      (plan != s.planCommitment || marketSnapshots[s.marketId] != s.snapshotHash)
    ) revert ConflictingPlan();
    (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(id, signature);
    if (err != ECDSA.RecoverError.NoError || signer != s.buyer) revert InvalidSignature();
  }

  function _markSettlementConsumed(Settlement calldata s, bytes32 id) private {
    executedSettlements[id] = true;
    paidAllocations[s.allocationId] = true;
    usedNonces[s.buyer][s.nonce] = true;
    if (marketPlans[s.marketId] == bytes32(0)) {
      marketPlans[s.marketId] = s.planCommitment;
      marketSnapshots[s.marketId] = s.snapshotHash;
    }
  }

  function _executeExactTokenTransfer(Settlement calldata s, bytes32 id) private {
    uint256 buyerBefore = paymentToken.balanceOf(s.buyer);
    uint256 sellerBefore = paymentToken.balanceOf(s.seller);
    _markSettlementConsumed(s, id);
    paymentToken.safeTransferFrom(s.buyer, s.seller, s.amountBaseUnits);
    uint256 buyerAfter = paymentToken.balanceOf(s.buyer);
    uint256 sellerAfter = paymentToken.balanceOf(s.seller);
    if (
      buyerAfter > buyerBefore ||
      buyerBefore - buyerAfter != s.amountBaseUnits ||
      sellerAfter < sellerBefore ||
      sellerAfter - sellerBefore != s.amountBaseUnits
    ) revert UnexpectedTokenBalance();
  }

  function _emitSettlement(Settlement calldata s, bytes32 id) private {
    emit EnergyPaymentSettled(
      id,
      s.marketId,
      s.allocationId,
      s.snapshotHash,
      s.planCommitment,
      s.buyer,
      s.seller,
      s.token,
      s.quantityWh,
      s.unitPriceMicrousdPerKwh,
      s.amountBaseUnits,
      s.algorithmId,
      s.pricingPolicyId,
      s.nonce
    );
  }
}
