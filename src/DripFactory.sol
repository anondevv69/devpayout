// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DripFeeRouter} from "./DripFeeRouter.sol";
import {HolderDistributor} from "./HolderDistributor.sol";

/// @title DripFactory
/// @notice Deploys a HolderDistributor + DripFeeRouter pair for any meme / paired-RWA pool.
/// Unlimited drips per RWA (no champion gate) — product can add policy later.
contract DripFactory {
    address public owner;
    address public keeper;
    address public treasury;
    address public lockVault;
    uint256 public lockSeconds;
    uint16 public platformFeeBps;

    uint256 public dripCount;
    mapping(uint256 => address) public routerAt;
    mapping(uint256 => address) public distributorAt;
    mapping(address => uint256) public dripIdByMeme; // 0 = none; else id+1
    mapping(address => bool) public isDripRouter;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event KeeperSet(address indexed keeper);
    event TreasurySet(address indexed treasury);
    event FeeBpsSet(uint16 platformFeeBps);
    event LockConfigSet(address indexed lockVault, uint256 lockSeconds);
    event DripCreated(
        uint256 indexed dripId,
        address indexed memeToken,
        address indexed pairedToken,
        address router,
        address distributor,
        address creator
    );

    error NotOwner();
    error ZeroAddress();
    error BadFee();
    error AlreadyRegistered();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address owner_,
        address keeper_,
        address treasury_,
        address lockVault_,
        uint256 lockSeconds_,
        uint16 platformFeeBps_
    ) {
        if (owner_ == address(0) || keeper_ == address(0) || treasury_ == address(0) || lockVault_ == address(0)) {
            revert ZeroAddress();
        }
        if (lockSeconds_ == 0 || platformFeeBps_ > 10_000) revert BadFee();
        owner = owner_;
        keeper = keeper_;
        treasury = treasury_;
        lockVault = lockVault_;
        lockSeconds = lockSeconds_;
        platformFeeBps = platformFeeBps_;
        emit OwnershipTransferred(address(0), owner_);
        emit KeeperSet(keeper_);
        emit TreasurySet(treasury_);
        emit FeeBpsSet(platformFeeBps_);
        emit LockConfigSet(lockVault_, lockSeconds_);
    }

    function createDrip(address memeToken, address pairedToken)
        external
        returns (uint256 dripId, address distributor, address router)
    {
        if (memeToken == address(0) || pairedToken == address(0)) revert ZeroAddress();
        if (dripIdByMeme[memeToken] != 0) revert AlreadyRegistered();

        HolderDistributor dist = new HolderDistributor(owner, keeper);
        DripFeeRouter feeRouter = new DripFeeRouter(
            memeToken, pairedToken, address(dist), lockVault, treasury, lockSeconds, platformFeeBps
        );

        dripId = dripCount++;
        distributorAt[dripId] = address(dist);
        routerAt[dripId] = address(feeRouter);
        dripIdByMeme[memeToken] = dripId + 1;
        isDripRouter[address(feeRouter)] = true;

        emit DripCreated(dripId, memeToken, pairedToken, address(feeRouter), address(dist), msg.sender);
        return (dripId, address(dist), address(feeRouter));
    }

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setPlatformFeeBps(uint16 platformFeeBps_) external onlyOwner {
        if (platformFeeBps_ > 10_000) revert BadFee();
        platformFeeBps = platformFeeBps_;
        emit FeeBpsSet(platformFeeBps_);
    }

    function setLockConfig(address lockVault_, uint256 lockSeconds_) external onlyOwner {
        if (lockVault_ == address(0) || lockSeconds_ == 0) revert ZeroAddress();
        lockVault = lockVault_;
        lockSeconds = lockSeconds_;
        emit LockConfigSet(lockVault_, lockSeconds_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
