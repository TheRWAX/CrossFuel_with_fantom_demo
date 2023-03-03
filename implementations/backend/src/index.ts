import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import cors from "cors";
import { ethers } from "ethers";

import { DefenderRelaySigner, DefenderRelayProvider } from "defender-relay-client/lib/ethers";

import deployments from "../../metamask-snap/packages/truffle/deployments.json";
import PaymasterJson from "../../metamask-snap/packages/truffle/build/VerifyingPaymaster.json";

import MockERC20Json from "../../metamask-snap/packages/truffle/build/MockERC20.json";

import { Squid } from "@0xsquid/sdk";

// instantiate the SDK
const squid = new Squid({
  baseUrl: "https://testnet.api.0xsquid.com", // for mainnet use "https://api.0xsquid.com"
});

dotenv.config();

const port = process.env.PORT || "8001";

// @dev: keep local signer implementation for zkSync integration
// const mnemonicPhrase = process.env.MNEMONIC_PHRASE || "";
// const infuraProjectId = process.env.INFURA_PROJECT_ID;

const app: Express = express();
app.use(cors());
app.use(express.json());
app.use((err: any, req: any, res: any, next: any) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});

const chainName = {
  "5": "goerli",
  "80001": "polygon-mumbai",
};
type ChainId = keyof typeof chainName;

const isChainId = (value: string): value is ChainId => {
  return Object.keys(chainName).includes(value);
};

const gasPaymentChainId = "5";

const getDefenderSignerByChainId = (chainId: ChainId) => {
  const credentials =
    chainId == "5"
      ? { apiKey: process.env.DEFENDER_GOERLI_PAI_KEY || "", apiSecret: process.env.DEFENDER_GOERLI_SECRET_KEY || "" }
      : { apiKey: process.env.DEFENDER_MUMBAI_PAI_KEY || "", apiSecret: process.env.DEFENDER_MUMBAI_SECRET_KEY || "" };
  const provider = new DefenderRelayProvider(credentials);
  const signer = new DefenderRelaySigner(credentials, provider, { speed: "fast" });
  return { provider, signer };
};

// const getSignerAndProviderForTargetChain = (chainId: ChainId) => {
//   const provider = new ethers.providers.JsonRpcProvider(
//     `https://${chainName[chainId]}.infura.io/v3/${infuraProjectId}`
//   );
//   const signer = ethers.Wallet.fromMnemonic(mnemonicPhrase).connect(provider);
//   return { provider, signer };
// };

app.get("/", async (req: Request, res: Response) => {
  console.log("hello");
  res.send("Hello");
});

app.get("/getSupportedPaymentTokens", async (req: Request, res: Response) => {
  console.log("getSupportedPaymentTokens");
  const { chainId } = req.query;
  if (typeof chainId !== "string" || !isChainId(chainId)) {
    res.send([]);
    return;
  }
  await squid.init();
  res.send(squid.tokens.filter((t) => t.chainId === parseInt(chainId)));
});

app.post("/faucet", async (req: Request, res: Response) => {
  console.log("faucet");
  const { to } = req.body;
  // const { signer } = getSignerAndProviderForTargetChain(gasPaymentChainId);
  const { signer } = getDefenderSignerByChainId(gasPaymentChainId);
  const mockERO20 = new ethers.Contract(deployments.mockERC20Address, MockERC20Json.abi, signer);
  const currentBalance = await mockERO20.balanceOf(to);
  const amount = 99;
  const threshold = 1;
  if (currentBalance.gte(ethers.utils.parseEther(threshold.toString()))) {
    res.send({
      status: "error",
      message: `AA wallet already has enough payment token in Georli`,
    });
  } else {
    const { hash } = await mockERO20.mint(to, ethers.utils.parseEther(amount.toString()));
    res.send({ status: "success", message: `Georli ${amount} mock payment token is sent to AA wallet: ${hash}` });
  }
});

app.post("/sign", async (req: Request, res: Response) => {
  console.log("sign");
  const { chainId, userOp } = req.body;
  const { paymasterAddress } = deployments;
  // const { provider, signer } = getSignerAndProviderForTargetChain(chainId);
  const { provider, signer } = getDefenderSignerByChainId(chainId);
  const paymasterContract = new ethers.Contract(paymasterAddress, PaymasterJson.abi, provider);
  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  const { timestamp } = block;

  const validUntil = timestamp + 1800;
  const validAfter = timestamp;

  const parsePaymasterAndDataWithoutAddressAndSignature = ethers.utils.defaultAbiCoder.encode(
    ["uint48", "uint48"],
    [validUntil, validAfter]
  );

  // @dev: firstly, let user sign user operation without paymaster signature
  if (!userOp.signature) {
    const paymasterAndData = ethers.utils.hexConcat([
      paymasterAddress,
      parsePaymasterAndDataWithoutAddressAndSignature,
      "0x" + "00".repeat(65),
    ]);
    res.send({ paymasterAndData });
  } else {
    // @dev: secondly, paymaster sign user operation with user signature, then user sign with user operation with paymaster signature
    const paymasterAndData = await paymasterContract
      .getHash(userOp, validUntil, validAfter)
      .then(async (hash: string) => {
        // await relayer.sign({ message: hash }).then(({ sig: signature }) => {
        //   console.log("recover test:", ethers.utils.recoverAddress(hash, signature));
        // });

        const signature = await signer.signMessage(ethers.utils.arrayify(hash));
        const paymasterAndData = ethers.utils.hexConcat([
          paymasterAddress,
          parsePaymasterAndDataWithoutAddressAndSignature,
          signature,
        ]);
        return paymasterAndData;
      })
      .catch((e: Error) => {
        console.error(e.message);
        return "0x";
      });
    res.send({ paymasterAndData });
  }
});

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});
