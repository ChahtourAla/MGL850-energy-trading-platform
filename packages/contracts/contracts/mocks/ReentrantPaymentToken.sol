// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

interface IEscrowReentryTarget {
  function fundTrade(uint256 onChainTradeId) external;
}

/// @notice Malicious ERC-20 used only for security testing.
contract ReentrantPaymentToken is ERC20 {
  address public attackTarget;
  uint256 public attackTradeId;

  bool public attackEnabled;
  bool public reentrySucceeded;

  bytes public reentryReturnData;

  constructor() ERC20('Reentrant Test USD', 'RTEUSD') {}

  function decimals() public pure override returns (uint8) {
    return 6;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function configureAttack(address target, uint256 tradeId) external {
    attackTarget = target;
    attackTradeId = tradeId;

    attackEnabled = true;
    reentrySucceeded = false;

    delete reentryReturnData;
  }

  function transferFrom(address from, address to, uint256 value) public override returns (bool) {
    if (attackEnabled) {
      attackEnabled = false;

      (bool success, bytes memory returnData) = attackTarget.call(
        abi.encodeCall(IEscrowReentryTarget.fundTrade, (attackTradeId))
      );

      reentrySucceeded = success;

      reentryReturnData = returnData;
    }

    return super.transferFrom(from, to, value);
  }
}
