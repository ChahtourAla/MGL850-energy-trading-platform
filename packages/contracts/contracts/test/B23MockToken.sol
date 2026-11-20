// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
contract B23MockToken is ERC20 {
  uint8 public mode; address public callbackTarget; bytes public callbackData; bool public callbackSucceeded;
  constructor() ERC20('Mock', 'MOCK') {}
  function decimals() public pure override returns(uint8){return 6;}
  function mint(address to,uint256 value) external {_mint(to,value);}
  function setMode(uint8 m) external {mode=m;}
  function setCallback(address target, bytes calldata data) external {callbackTarget=target;callbackData=data;}
  function transferFrom(address from,address to,uint256 value) public override returns(bool){
    if(mode==1) return false;
    if(mode==2) revert('MOCK_REVERT');
    if(mode==4){(callbackSucceeded,)=callbackTarget.call(callbackData);}
    if(mode==3){super.transferFrom(from,to,value-1);super.transferFrom(from,address(0xdead),1);return true;}
    return super.transferFrom(from,to,value);
  }
}

contract B23WrongDecimals is ERC20 { constructor() ERC20('Wrong decimals','BAD') {} }
