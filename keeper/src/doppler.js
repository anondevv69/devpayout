const DOPPLER_API = "https://api.bankr.bot/public/doppler";

export async function fetchDopplerMeta(tokenAddress) {
  const res = await fetch(`${DOPPLER_API}/token-fees/${tokenAddress}`);
  if (!res.ok) throw new Error(`doppler token-fees ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const token = body.tokens?.find(
    (t) => t.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase(),
  );
  if (!token) throw new Error(`no doppler pool for ${tokenAddress}`);
  return {
    poolId: token.poolId,
    initializer: token.initializer,
    claimable: token.claimable,
  };
}

export async function fetchClaimable(beneficiary, tokenAddress) {
  const url = `${DOPPLER_API}/claimable-fees/${tokenAddress}?beneficiary=${beneficiary}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`doppler claimable ${res.status}: ${await res.text()}`);
  return res.json();
}

function hasClaimable(claimable) {
  if (!claimable) return false;
  const t0 = Number(claimable.token0 || 0);
  const t1 = Number(claimable.token1 || 0);
  return t0 > 0 || t1 > 0;
}

export async function claimDopplerIfAvailable(publicClient, wallet, router, devToken) {
  const beneficiary = router;
  const status = await fetchClaimable(beneficiary, devToken);
  if (!status.eligible) {
    console.log("doppler not eligible for router", devToken);
    return;
  }
  if (!hasClaimable(status.claimableFees)) {
    console.log("doppler no claimable fees yet", status.claimableFees);
    return;
  }

  const { poolId, initializer } = await fetchDopplerMeta(devToken);
  console.log("doppler claim", { poolId, initializer, claimable: status.claimableFees });

  const claimDopplerAbi = [
    {
      name: "claimDoppler",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [
        { name: "initializer", type: "address" },
        { name: "poolId", type: "bytes32" },
      ],
      outputs: [
        { name: "amount0", type: "uint256" },
        { name: "amount1", type: "uint256" },
      ],
    },
  ];

  const hash = await wallet.writeContract({
    address: router,
    abi: claimDopplerAbi,
    functionName: "claimDoppler",
    args: [initializer, poolId],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("claimDoppler", hash, receipt.status);
}
