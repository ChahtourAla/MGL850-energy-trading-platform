// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {AccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

/// @title EnergyTradingEscrow
/// @notice Manages peer-to-peer energy trades and payment escrow.
/// @dev Core trade lifecycle functions will be implemented incrementally
///      in the next development steps.
contract EnergyTradingEscrow is AccessControl, Pausable, ReentrancyGuard {
  using SafeERC20 for IERC20;

  // ---------------------------------------------------------------------
  // Roles
  // ---------------------------------------------------------------------

  bytes32 public constant OPERATOR_ROLE = keccak256('OPERATOR_ROLE');

  bytes32 public constant ORACLE_ROLE = keccak256('ORACLE_ROLE');

  bytes32 public constant PAUSER_ROLE = keccak256('PAUSER_ROLE');

  // ---------------------------------------------------------------------
  // Trade states
  // ---------------------------------------------------------------------

  enum TradeStatus {
    CREATED,
    FUNDED,
    AWAITING_DELIVERY,
    DELIVERED,
    COMPLETED,
    CANCELLED,
    EXPIRED,
    FAILED,
    REFUNDED
  }

  // ---------------------------------------------------------------------
  // Trade model
  // ---------------------------------------------------------------------

  struct Trade {
    bytes32 externalTradeId;
    address buyer;
    address seller;
    uint256 quantityWh;
    uint256 unitPriceMicrousdPerKwh;
    uint256 totalAmountMicrousd;
    uint64 deliveryStart;
    uint64 deliveryDeadline;
    uint256 deliveredWh;
    bytes32 evidenceHash;
    TradeStatus status;
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  IERC20 public immutable paymentToken;

  uint256 private _nextTradeId = 1;

  mapping(uint256 => Trade) private _trades;

  mapping(bytes32 => uint256) private _externalTradeToOnChainId;

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------

  event TradeCreated(
    uint256 indexed onChainTradeId,
    bytes32 indexed externalTradeId,
    address indexed buyer,
    address seller,
    uint256 quantityWh,
    uint256 unitPriceMicrousdPerKwh
  );

  event TradeFunded(uint256 indexed onChainTradeId, uint256 amount);

  event DeliveryConfirmed(
    uint256 indexed onChainTradeId,
    uint256 deliveredWh,
    bytes32 evidenceHash
  );

  event TradeSettled(uint256 indexed onChainTradeId, address indexed seller, uint256 amount);

  event TradeRefunded(uint256 indexed onChainTradeId, address indexed buyer, uint256 amount);

  event TradeCancelled(uint256 indexed onChainTradeId);

  event TradeExpired(uint256 indexed onChainTradeId);

  // ---------------------------------------------------------------------
  // Custom errors
  // ---------------------------------------------------------------------

  error ZeroAddress();

  error InvalidExternalTradeId();

  error ExternalTradeIdAlreadyUsed(bytes32 externalTradeId);

  error TradeNotFound(uint256 onChainTradeId);

  error InvalidTradeParties();

  error InvalidQuantity();

  error InvalidUnitPrice();

  error InvalidPaymentAmount();

  error InvalidDeliveryWindow();

  error InvalidTradeStatus(
    uint256 onChainTradeId,
    TradeStatus currentStatus,
    TradeStatus requiredStatus
  );

  error InsufficientDelivery(uint256 expectedWh, uint256 deliveredWh);

  error DeliveryDeadlineNotReached(uint256 currentTimestamp, uint256 deliveryDeadline);

  error InsufficientBuyerBalance(uint256 availableBalance, uint256 requiredAmount);

  error InsufficientBuyerAllowance(uint256 currentAllowance, uint256 requiredAmount);

  // ---------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------

  constructor(
    address paymentToken_,
    address initialAdmin,
    address initialOperator,
    address initialOracle,
    address initialPauser
  ) {
    if (
      paymentToken_ == address(0) ||
      initialAdmin == address(0) ||
      initialOperator == address(0) ||
      initialOracle == address(0) ||
      initialPauser == address(0)
    ) {
      revert ZeroAddress();
    }

    paymentToken = IERC20(paymentToken_);

    _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);

    _grantRole(OPERATOR_ROLE, initialOperator);

    _grantRole(ORACLE_ROLE, initialOracle);

    _grantRole(PAUSER_ROLE, initialPauser);
  }

  // ---------------------------------------------------------------------
  // Pause management
  // ---------------------------------------------------------------------

  function pause() external onlyRole(PAUSER_ROLE) {
    _pause();
  }

  function unpause() external onlyRole(PAUSER_ROLE) {
    _unpause();
  }

  // ---------------------------------------------------------------------
  // Trade creation
  // ---------------------------------------------------------------------

  function createTrade(
    bytes32 externalTradeId,
    address buyer,
    address seller,
    uint256 quantityWh,
    uint256 unitPriceMicrousdPerKwh,
    uint64 deliveryStart,
    uint64 deliveryDeadline
  ) external onlyRole(OPERATOR_ROLE) whenNotPaused returns (uint256 onChainTradeId) {
    if (externalTradeId == bytes32(0)) {
      revert InvalidExternalTradeId();
    }

    if (_externalTradeToOnChainId[externalTradeId] != 0) {
      revert ExternalTradeIdAlreadyUsed(externalTradeId);
    }

    if (buyer == address(0) || seller == address(0)) {
      revert ZeroAddress();
    }

    if (buyer == seller) {
      revert InvalidTradeParties();
    }

    if (quantityWh == 0) {
      revert InvalidQuantity();
    }

    if (unitPriceMicrousdPerKwh == 0) {
      revert InvalidUnitPrice();
    }

    if (deliveryStart == 0 || deliveryDeadline <= deliveryStart) {
      revert InvalidDeliveryWindow();
    }

    uint256 totalAmountMicrousd = Math.mulDiv(quantityWh, unitPriceMicrousdPerKwh, 1000);

    if (totalAmountMicrousd == 0) {
      revert InvalidPaymentAmount();
    }

    onChainTradeId = _nextTradeId;

    unchecked {
      _nextTradeId++;
    }

    _trades[onChainTradeId] = Trade({
      externalTradeId: externalTradeId,
      buyer: buyer,
      seller: seller,
      quantityWh: quantityWh,
      unitPriceMicrousdPerKwh: unitPriceMicrousdPerKwh,
      totalAmountMicrousd: totalAmountMicrousd,
      deliveryStart: deliveryStart,
      deliveryDeadline: deliveryDeadline,
      deliveredWh: 0,
      evidenceHash: bytes32(0),
      status: TradeStatus.CREATED
    });

    _externalTradeToOnChainId[externalTradeId] = onChainTradeId;

    emit TradeCreated(
      onChainTradeId,
      externalTradeId,
      buyer,
      seller,
      quantityWh,
      unitPriceMicrousdPerKwh
    );

    return onChainTradeId;
  }

  // ---------------------------------------------------------------------
  // Trade funding
  // ---------------------------------------------------------------------

  function fundTrade(
    uint256 onChainTradeId
  ) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
    Trade storage trade = _trades[onChainTradeId];

    if (trade.externalTradeId == bytes32(0)) {
      revert TradeNotFound(onChainTradeId);
    }

    if (trade.status != TradeStatus.CREATED) {
      revert InvalidTradeStatus(onChainTradeId, trade.status, TradeStatus.CREATED);
    }

    uint256 requiredAmount = trade.totalAmountMicrousd;

    uint256 buyerBalance = paymentToken.balanceOf(trade.buyer);

    if (buyerBalance < requiredAmount) {
      revert InsufficientBuyerBalance(buyerBalance, requiredAmount);
    }

    uint256 buyerAllowance = paymentToken.allowance(trade.buyer, address(this));

    if (buyerAllowance < requiredAmount) {
      revert InsufficientBuyerAllowance(buyerAllowance, requiredAmount);
    }

    // Intermediate lifecycle state.
    trade.status = TradeStatus.FUNDED;

    paymentToken.safeTransferFrom(trade.buyer, address(this), requiredAmount);

    trade.status = TradeStatus.AWAITING_DELIVERY;

    emit TradeFunded(onChainTradeId, requiredAmount);
  }

  // ---------------------------------------------------------------------
  // Delivery confirmation and settlement
  // ---------------------------------------------------------------------

  function confirmDelivery(
    uint256 onChainTradeId,
    uint256 deliveredWh,
    bytes32 evidenceHash
  ) external onlyRole(ORACLE_ROLE) whenNotPaused nonReentrant {
    Trade storage trade = _trades[onChainTradeId];

    if (trade.externalTradeId == bytes32(0)) {
      revert TradeNotFound(onChainTradeId);
    }

    if (trade.status != TradeStatus.AWAITING_DELIVERY) {
      revert InvalidTradeStatus(onChainTradeId, trade.status, TradeStatus.AWAITING_DELIVERY);
    }

    if (deliveredWh < trade.quantityWh) {
      revert InsufficientDelivery(trade.quantityWh, deliveredWh);
    }

    trade.deliveredWh = deliveredWh;

    trade.evidenceHash = evidenceHash;

    // Record successful delivery.
    trade.status = TradeStatus.DELIVERED;

    emit DeliveryConfirmed(onChainTradeId, deliveredWh, evidenceHash);

    uint256 settlementAmount = trade.totalAmountMicrousd;

    // Effects are applied before the external token transfer.
    trade.status = TradeStatus.COMPLETED;

    paymentToken.safeTransfer(trade.seller, settlementAmount);

    emit TradeSettled(onChainTradeId, trade.seller, settlementAmount);
  }

  // ---------------------------------------------------------------------
  // Trade cancellation
  // ---------------------------------------------------------------------

  function cancelTrade(uint256 onChainTradeId) external onlyRole(OPERATOR_ROLE) whenNotPaused {
    Trade storage trade = _trades[onChainTradeId];

    if (trade.externalTradeId == bytes32(0)) {
      revert TradeNotFound(onChainTradeId);
    }

    if (trade.status != TradeStatus.CREATED) {
      revert InvalidTradeStatus(onChainTradeId, trade.status, TradeStatus.CREATED);
    }

    trade.status = TradeStatus.CANCELLED;

    emit TradeCancelled(onChainTradeId);
  }

  // ---------------------------------------------------------------------
  // Trade expiration
  // ---------------------------------------------------------------------

  function expireTrade(uint256 onChainTradeId) external onlyRole(OPERATOR_ROLE) whenNotPaused {
    Trade storage trade = _trades[onChainTradeId];

    if (trade.externalTradeId == bytes32(0)) {
      revert TradeNotFound(onChainTradeId);
    }

    if (trade.status != TradeStatus.AWAITING_DELIVERY) {
      revert InvalidTradeStatus(onChainTradeId, trade.status, TradeStatus.AWAITING_DELIVERY);
    }

    if (block.timestamp <= trade.deliveryDeadline) {
      revert DeliveryDeadlineNotReached(block.timestamp, trade.deliveryDeadline);
    }

    trade.status = TradeStatus.EXPIRED;

    emit TradeExpired(onChainTradeId);
  }

  // ---------------------------------------------------------------------
  // Buyer refund
  // ---------------------------------------------------------------------

  function refundTrade(
    uint256 onChainTradeId
  ) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
    Trade storage trade = _trades[onChainTradeId];

    if (trade.externalTradeId == bytes32(0)) {
      revert TradeNotFound(onChainTradeId);
    }

    if (trade.status != TradeStatus.EXPIRED) {
      revert InvalidTradeStatus(onChainTradeId, trade.status, TradeStatus.EXPIRED);
    }

    uint256 refundAmount = trade.totalAmountMicrousd;

    // Effects before interaction.
    trade.status = TradeStatus.REFUNDED;

    paymentToken.safeTransfer(trade.buyer, refundAmount);

    emit TradeRefunded(onChainTradeId, trade.buyer, refundAmount);
  }

  // ---------------------------------------------------------------------
  // Read functions
  // ---------------------------------------------------------------------

  /// @notice Returns a stored trade.
  function getTrade(uint256 onChainTradeId) external view returns (Trade memory) {
    if (_trades[onChainTradeId].externalTradeId == bytes32(0)) {
      revert TradeNotFound(onChainTradeId);
    }

    return _trades[onChainTradeId];
  }

  /// @notice Returns the on-chain trade ID associated with
  ///         a backend external trade ID.
  /// @dev Returns zero when the external trade ID does not exist.
  function getOnChainTradeId(bytes32 externalTradeId) external view returns (uint256) {
    return _externalTradeToOnChainId[externalTradeId];
  }

  /// @notice Returns the ID that will be assigned to the next trade.
  function nextTradeId() external view returns (uint256) {
    return _nextTradeId;
  }
}
