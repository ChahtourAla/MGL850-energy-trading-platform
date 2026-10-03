// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {AccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';

/// @title TestEnergyUSD
/// @notice Test-only ERC-20 token used to simulate energy payments.
/// @dev The token uses 6 decimals so one token unit maps naturally
///      to micro-USD values used by the prototype.
contract TestEnergyUSD is ERC20, AccessControl {
  bytes32 public constant MINTER_ROLE = keccak256('MINTER_ROLE');

  error ZeroAddress();
  error ZeroAmount();

  constructor(address initialAdmin) ERC20('Test Energy USD', 'TEUSD') {
    if (initialAdmin == address(0)) {
      revert ZeroAddress();
    }

    _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    _grantRole(MINTER_ROLE, initialAdmin);
  }

  /// @notice Returns the number of decimals used by TEUSD.
  function decimals() public pure override returns (uint8) {
    return 6;
  }

  /// @notice Mints test tokens.
  /// @dev Only accounts with MINTER_ROLE can mint tokens.
  function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
    if (to == address(0)) {
      revert ZeroAddress();
    }

    if (amount == 0) {
      revert ZeroAmount();
    }

    _mint(to, amount);
  }
}
