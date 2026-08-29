// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title MsftHolderDistributor
/// @notice Daily MSFT payouts to $dev token holders. Keeper snapshots holder balances
/// off-chain at `checkpointBlock`, seals a Merkle root, and pushes MSFT in batches.
contract MsftHolderDistributor {
    enum Phase {
        Open,
        Locked
    }

    struct Round {
        address payoutToken;
        address holderToken;
        uint64 checkpointBlock;
        uint32 recipientCount;
        uint32 paidCount;
        uint256 payoutAmount;
        uint256 paidOut;
        bytes32 merkleRoot;
        Phase phase;
    }

    address public owner;
    address public keeper;
    uint256 public roundCount;

    mapping(uint256 => Round) internal _rounds;
    mapping(uint256 => mapping(address => bool)) public paid;

    event RoundOpened(
        uint256 indexed roundId, address indexed payoutToken, address indexed holderToken, uint64 checkpointBlock
    );
    event RoundFunded(uint256 indexed roundId, uint256 added, uint256 payoutAmount);
    event RoundLocked(uint256 indexed roundId, bytes32 merkleRoot, uint32 recipientCount, uint256 payoutAmount);
    event BatchPaid(
        uint256 indexed roundId, uint32 paidInBatch, uint256 amountInBatch, uint32 paidCount, uint256 paidOut
    );
    event RoundComplete(uint256 indexed roundId, uint32 paidCount, uint256 paidOut);
    event KeeperSet(address indexed previousKeeper, address indexed newKeeper);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DustSwept(uint256 indexed roundId, address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotKeeper();
    error BadCheckpoint();
    error WrongPhase();
    error AlreadyPaid();
    error BadProof();
    error ArrayMismatch();
    error ZeroAmount();
    error ZeroRecipients();
    error RoundNotComplete();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner) revert NotKeeper();
        _;
    }

    constructor(address owner_, address keeper_) {
        owner = owner_;
        keeper = keeper_;
        emit OwnershipTransferred(address(0), owner_);
        emit KeeperSet(address(0), keeper_);
    }

    function openRound(address payoutToken, address holderToken, uint64 checkpointBlock)
        external
        onlyKeeper
        returns (uint256 roundId)
    {
        if (payoutToken == address(0) || holderToken == address(0)) revert ZeroAmount();
        if (checkpointBlock >= block.number) revert BadCheckpoint();
        roundId = roundCount++;
        Round storage r = _rounds[roundId];
        r.payoutToken = payoutToken;
        r.holderToken = holderToken;
        r.checkpointBlock = checkpointBlock;
        r.phase = Phase.Open;
        emit RoundOpened(roundId, payoutToken, holderToken, checkpointBlock);
    }

    function fundRound(uint256 roundId, uint256 tokenAmount) external {
        Round storage r = _rounds[roundId];
        if (r.phase != Phase.Open) revert WrongPhase();
        if (tokenAmount == 0) revert ZeroAmount();
        if (!IERC20(r.payoutToken).transferFrom(msg.sender, address(this), tokenAmount)) revert TransferFailed();
        r.payoutAmount += tokenAmount;
        emit RoundFunded(roundId, tokenAmount, r.payoutAmount);
    }

    /// @notice Credit MSFT already sitting on this contract (routed from DevMsftFeeRouter).
    function absorbBalance(uint256 roundId) external onlyKeeper returns (uint256 added) {
        Round storage r = _rounds[roundId];
        if (r.phase != Phase.Open) revert WrongPhase();
        uint256 bal = IERC20(r.payoutToken).balanceOf(address(this));
        if (bal <= r.payoutAmount) revert ZeroAmount();
        added = bal - r.payoutAmount;
        r.payoutAmount = bal;
        emit RoundFunded(roundId, added, r.payoutAmount);
    }

    function lockRound(uint256 roundId, bytes32 merkleRoot, uint32 recipientCount) external onlyKeeper {
        Round storage r = _rounds[roundId];
        if (r.phase != Phase.Open) revert WrongPhase();
        if (r.payoutAmount == 0) revert ZeroAmount();
        if (recipientCount == 0) revert ZeroRecipients();
        if (merkleRoot == bytes32(0)) revert BadProof();
        r.merkleRoot = merkleRoot;
        r.recipientCount = recipientCount;
        r.phase = Phase.Locked;
        emit RoundLocked(roundId, merkleRoot, recipientCount, r.payoutAmount);
    }

    function payBatch(
        uint256 roundId,
        address[] calldata recipients,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external {
        Round storage r = _rounds[roundId];
        if (r.phase != Phase.Locked) revert WrongPhase();
        if (r.paidCount >= r.recipientCount) revert WrongPhase();
        uint256 n = recipients.length;
        if (n == 0) revert ZeroRecipients();
        if (amounts.length != n || proofs.length != n) revert ArrayMismatch();
        IERC20 tok = IERC20(r.payoutToken);
        uint256 batchAmount;
        uint32 batchPaid;
        for (uint256 i = 0; i < n; i++) {
            address who = recipients[i];
            uint256 amt = amounts[i];
            if (amt == 0) revert ZeroAmount();
            if (paid[roundId][who]) revert AlreadyPaid();
            if (!_verifyProof(r.merkleRoot, keccak256(abi.encodePacked(who, amt)), proofs[i])) {
                revert BadProof();
            }
            paid[roundId][who] = true;
            batchAmount += amt;
            batchPaid++;
            if (!tok.transfer(who, amt)) revert TransferFailed();
        }
        r.paidOut += batchAmount;
        r.paidCount += batchPaid;
        emit BatchPaid(roundId, batchPaid, batchAmount, r.paidCount, r.paidOut);
        if (r.paidCount >= r.recipientCount) {
            emit RoundComplete(roundId, r.paidCount, r.paidOut);
        }
    }

    function roundInfo(uint256 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    function isComplete(uint256 roundId) public view returns (bool) {
        Round storage r = _rounds[roundId];
        return r.phase == Phase.Locked && r.paidCount >= r.recipientCount;
    }

    function sweepDust(uint256 roundId, address to) external onlyOwner {
        if (!isComplete(roundId)) revert RoundNotComplete();
        Round storage r = _rounds[roundId];
        uint256 dust = r.payoutAmount - r.paidOut;
        if (dust == 0) revert ZeroAmount();
        r.paidOut += dust;
        if (!IERC20(r.payoutToken).transfer(to, dust)) revert TransferFailed();
        emit DustSwept(roundId, r.payoutToken, to, dust);
    }

    function setKeeper(address keeper_) external onlyOwner {
        emit KeeperSet(keeper, keeper_);
        keeper = keeper_;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAmount();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _verifyProof(bytes32 root, bytes32 leaf, bytes32[] calldata proof) internal pure returns (bool) {
        bytes32 hash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            if (hash <= p) {
                hash = keccak256(abi.encodePacked(hash, p));
            } else {
                hash = keccak256(abi.encodePacked(p, hash));
            }
        }
        return hash == root;
    }
}
