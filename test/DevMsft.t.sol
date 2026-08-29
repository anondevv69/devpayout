// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DevMsftFeeRouter} from "../src/DevMsftFeeRouter.sol";
import {MsftHolderDistributor} from "../src/MsftHolderDistributor.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allow");
        require(balanceOf[from] >= amount, "bal");
        allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockLockVault {
    uint256 public nextId = 1;

    function deposit(address token, uint256 amount, uint256) external returns (uint256 lockId) {
        MockERC20(token).transferFrom(msg.sender, address(this), amount);
        lockId = nextId++;
    }
}

contract DevMsftTest is Test {
    uint256 internal constant LOCK_SECONDS = 2_175_984_000;

    MockERC20 internal dev;
    MockERC20 internal msft;
    MockLockVault internal vault;
    MsftHolderDistributor internal distributor;
    DevMsftFeeRouter internal router;

    address internal keeper = address(0xBEEF);
    address internal holderA = address(0xA11CE);
    address internal holderB = address(0xB0B);

    function setUp() public {
        dev = new MockERC20();
        msft = new MockERC20();
        vault = new MockLockVault();
        distributor = new MsftHolderDistributor(address(this), keeper);
        router = new DevMsftFeeRouter(
            address(dev), address(msft), address(distributor), address(vault), LOCK_SECONDS
        );
    }

    function test_route_locks_dev_and_routes_msft() public {
        dev.mint(address(router), 1_000e18);
        msft.mint(address(router), 500e18);

        (uint256 devAmt, uint256 msftAmt, uint256 lockId) = router.route();

        assertEq(devAmt, 1_000e18);
        assertEq(msftAmt, 500e18);
        assertEq(lockId, 1);
        assertEq(dev.balanceOf(address(vault)), 1_000e18);
        assertEq(msft.balanceOf(address(distributor)), 500e18);
    }

    function test_route_reverts_when_empty() public {
        vm.expectRevert(DevMsftFeeRouter.NothingToRoute.selector);
        router.route();
    }

    function test_routeToken_dev_only() public {
        dev.mint(address(router), 250e18);
        uint256 amount = router.routeToken(address(dev));
        assertEq(amount, 250e18);
        assertEq(dev.balanceOf(address(vault)), 250e18);
    }

    function test_routeToken_msft_only() public {
        msft.mint(address(router), 75e18);
        uint256 amount = router.routeToken(address(msft));
        assertEq(amount, 75e18);
        assertEq(msft.balanceOf(address(distributor)), 75e18);
    }

    function test_routeToken_reverts_unknown() public {
        MockERC20 other = new MockERC20();
        other.mint(address(router), 1e18);
        vm.expectRevert(DevMsftFeeRouter.UnknownToken.selector);
        router.routeToken(address(other));
    }

    function test_absorb_lock_payBatch() public {
        msft.mint(address(distributor), 1_000e18);
        vm.prank(keeper);
        uint256 roundId = distributor.openRound(address(msft), address(dev), uint64(block.number - 1));
        vm.prank(keeper);
        distributor.absorbBalance(roundId);

        bytes32 leafA = keccak256(abi.encodePacked(holderA, uint256(600e18)));
        bytes32 leafB = keccak256(abi.encodePacked(holderB, uint256(400e18)));
        bytes32 root = _pair(leafA, leafB);

        vm.prank(keeper);
        distributor.lockRound(roundId, root, 2);

        address[] memory recipients = new address[](2);
        recipients[0] = holderA;
        recipients[1] = holderB;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 600e18;
        amounts[1] = 400e18;
        bytes32[][] memory proofs = new bytes32[][](2);
        proofs[0] = _proof(leafA, leafB);
        proofs[1] = _proof(leafB, leafA);

        distributor.payBatch(roundId, recipients, amounts, proofs);
        assertEq(msft.balanceOf(holderA), 600e18);
        assertEq(msft.balanceOf(holderB), 400e18);
        assertTrue(distributor.isComplete(roundId));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _proof(bytes32 leaf, bytes32 sibling) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = sibling;
    }
}
