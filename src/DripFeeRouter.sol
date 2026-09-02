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

/// @title DripFeeRouter
/// @notice Doppler fee router for a meme / paired-RWA pool.
/// Keeper claims fees, then `route()`:
/// - 100% of meme is locked in TimeLockVault
/// - platformFeeBps of paired RWA → treasury
/// - remainder of paired RWA → HolderDistributor
contract DripFeeRouter is IERC721Receiver {
    uint256 public constant BPS = 10_000;

    address public immutable MEME_TOKEN;
    address public immutable PAIRED_TOKEN;
    address public immutable DISTRIBUTOR;
    address public immutable LOCK_VAULT;
    address public immutable TREASURY;
    uint256 public immutable LOCK_SECONDS;
    uint16 public immutable PLATFORM_FEE_BPS;

    event MemeLocked(address indexed vault, uint256 amount, uint256 lockId);
    event PairedRouted(address indexed to, uint256 amount);
    event PlatformFeePaid(address indexed treasury, uint256 amount);
    event FeesRouted(uint256 memeAmount, uint256 pairedGross, uint256 pairedToHolders, uint256 platformFee, uint256 lockId);

    error ZeroAddress();
    error ZeroDuration();
    error BadFee();
    error UnknownToken();
    error NothingToRoute();
    error TransferFailed();

    constructor(
        address memeToken_,
        address pairedToken_,
        address distributor_,
        address lockVault_,
        address treasury_,
        uint256 lockSeconds_,
        uint16 platformFeeBps_
    ) {
        if (
            memeToken_ == address(0) || pairedToken_ == address(0) || distributor_ == address(0)
                || lockVault_ == address(0) || treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (lockSeconds_ == 0) revert ZeroDuration();
        if (platformFeeBps_ > BPS) revert BadFee();
        MEME_TOKEN = memeToken_;
        PAIRED_TOKEN = pairedToken_;
        DISTRIBUTOR = distributor_;
        LOCK_VAULT = lockVault_;
        TREASURY = treasury_;
        LOCK_SECONDS = lockSeconds_;
        PLATFORM_FEE_BPS = platformFeeBps_;
    }

    function route()
        external
        returns (uint256 memeAmount, uint256 pairedGross, uint256 pairedToHolders, uint256 platformFee, uint256 lockId)
    {
        memeAmount = IERC20(MEME_TOKEN).balanceOf(address(this));
        pairedGross = IERC20(PAIRED_TOKEN).balanceOf(address(this));
        if (memeAmount == 0 && pairedGross == 0) revert NothingToRoute();

        if (memeAmount > 0) {
            lockId = _lockMeme(memeAmount);
        }

        if (pairedGross > 0) {
            platformFee = (pairedGross * PLATFORM_FEE_BPS) / BPS;
            pairedToHolders = pairedGross - platformFee;
            if (platformFee != 0) {
                if (!IERC20(PAIRED_TOKEN).transfer(TREASURY, platformFee)) revert TransferFailed();
                emit PlatformFeePaid(TREASURY, platformFee);
            }
            if (pairedToHolders != 0) {
                if (!IERC20(PAIRED_TOKEN).transfer(DISTRIBUTOR, pairedToHolders)) revert TransferFailed();
                emit PairedRouted(DISTRIBUTOR, pairedToHolders);
            }
        }

        emit FeesRouted(memeAmount, pairedGross, pairedToHolders, platformFee, lockId);
    }

    function claimDoppler(address initializer, bytes32 poolId)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        if (initializer == address(0)) revert ZeroAddress();
        return IDopplerFees(initializer).collectFees(poolId);
    }

    function _lockMeme(uint256 amount) internal returns (uint256 lockId) {
        if (!IERC20(MEME_TOKEN).approve(LOCK_VAULT, amount)) revert TransferFailed();
        lockId = ITimeLockVault(LOCK_VAULT).deposit(MEME_TOKEN, amount, LOCK_SECONDS);
        emit MemeLocked(LOCK_VAULT, amount, lockId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
