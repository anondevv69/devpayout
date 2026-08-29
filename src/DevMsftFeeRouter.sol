// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ITimeLockVault {
    function deposit(address token, uint256 amount, uint256 lockTime) external returns (uint256 lockId);
}

interface IDopplerFees {
    function collectFees(bytes32 poolId) external returns (uint256 amount0, uint256 amount1);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// @title DevMsftFeeRouter
/// @notice Doppler fee router for DEVS / MSFT on Robinhood Chain.
/// Keeper claims Doppler fees into this contract, then calls `route()`:
/// - 100% of DEVS is locked in TimeLockVault
/// - 100% of MSFT is forwarded to MsftHolderDistributor for holder payouts
contract DevMsftFeeRouter is IERC721Receiver {
    address public immutable DEV_TOKEN;
    address public immutable MSFT_TOKEN;
    address public immutable DISTRIBUTOR;
    address public immutable LOCK_VAULT;
    uint256 public immutable LOCK_SECONDS;

    event DevLocked(address indexed vault, uint256 amount, uint256 lockId);
    event MsftRouted(address indexed to, uint256 amount);
    event FeesRouted(uint256 devAmount, uint256 msftAmount, uint256 lockId);

    error ZeroAddress();
    error ZeroDuration();
    error UnknownToken();
    error NothingToRoute();
    error TransferFailed();

    constructor(
        address devToken_,
        address msftToken_,
        address distributor_,
        address lockVault_,
        uint256 lockSeconds_
    ) {
        if (
            devToken_ == address(0) || msftToken_ == address(0) || distributor_ == address(0)
                || lockVault_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (lockSeconds_ == 0) revert ZeroDuration();
        DEV_TOKEN = devToken_;
        MSFT_TOKEN = msftToken_;
        DISTRIBUTOR = distributor_;
        LOCK_VAULT = lockVault_;
        LOCK_SECONDS = lockSeconds_;
    }

    /// @notice Lock all DEVS and forward all MSFT sitting on this contract.
    function route() external returns (uint256 devAmount, uint256 msftAmount, uint256 lockId) {
        devAmount = IERC20(DEV_TOKEN).balanceOf(address(this));
        msftAmount = IERC20(MSFT_TOKEN).balanceOf(address(this));
        if (devAmount == 0 && msftAmount == 0) revert NothingToRoute();

        if (devAmount > 0) {
            lockId = _lockDev(devAmount);
        }

        if (msftAmount > 0) {
            if (!IERC20(MSFT_TOKEN).transfer(DISTRIBUTOR, msftAmount)) revert TransferFailed();
            emit MsftRouted(DISTRIBUTOR, msftAmount);
        }

        emit FeesRouted(devAmount, msftAmount, lockId);
    }

    /// @notice Route a single token balance. Only DEVS and MSFT are accepted.
    function routeToken(address token) external returns (uint256 amount) {
        if (token == DEV_TOKEN) {
            amount = IERC20(DEV_TOKEN).balanceOf(address(this));
            if (amount == 0) revert NothingToRoute();
            _lockDev(amount);
            return amount;
        }
        if (token == MSFT_TOKEN) {
            amount = IERC20(MSFT_TOKEN).balanceOf(address(this));
            if (amount == 0) revert NothingToRoute();
            if (!IERC20(MSFT_TOKEN).transfer(DISTRIBUTOR, amount)) revert TransferFailed();
            emit MsftRouted(DISTRIBUTOR, amount);
            return amount;
        }
        revert UnknownToken();
    }

    /// @notice Claim Doppler pool fees when this contract is the fee beneficiary.
    function claimDoppler(address initializer, bytes32 poolId)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        if (initializer == address(0)) revert ZeroAddress();
        return IDopplerFees(initializer).collectFees(poolId);
    }

    function _lockDev(uint256 amount) internal returns (uint256 lockId) {
        if (!IERC20(DEV_TOKEN).approve(LOCK_VAULT, amount)) revert TransferFailed();
        lockId = ITimeLockVault(LOCK_VAULT).deposit(DEV_TOKEN, amount, LOCK_SECONDS);
        emit DevLocked(LOCK_VAULT, amount, lockId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
