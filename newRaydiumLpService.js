const { Connection, PublicKey } = require("@solana/web3.js");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const connection = new Connection(process.env.SOLANA_WS_URL, "confirmed");
const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(process.env.RAYDIUM_AMM_PROGRAM_ID);
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID_STR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID_STR = "ATokenGPv1sfdS5qUnx9GbS6hX1TTjR1L6rT3HaZJFA";

let db;

async function connectToDatabase() {
    const mongoUri = process.env.MONGO_URI;
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        db = client.db("bot");
        console.log("Connected to MongoDB successfully.");
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    }
}

async function saveToMongo(tokenData) {
    try {
        if (!db) {
            throw new Error("Database connection is not initialized");
        }
        const collection = db.collection("raydium_lp_transactionsV2");
        const result = await collection.insertOne(tokenData);

        if (result.acknowledged) {
            console.log("Token data saved to MongoDB:", result.insertedId);
        } else {
            console.error("Failed to save token data to MongoDB.");
        }
    } catch (error) {
        console.error("Error saving token data to MongoDB:", error.message);
    }
}

function invertCoinAndPcMint(tokenData) {
    const SPECIAL_COIN_MINT = "So11111111111111111111111111111111111111112";
    if (tokenData.tokenAddress === SPECIAL_COIN_MINT) {
        [tokenData.tokenAddress, tokenData.solAddress] = [tokenData.solAddress, tokenData.tokenAddress];
        [tokenData.tokenVault, tokenData.solVault] = [tokenData.solVault, tokenData.tokenVault];
    }
    return tokenData;
}

function parseCreateAmmLpParams(data) {
    return {
        discriminator: data.readUInt8(0),
        nonce: data.readUInt8(1),
        openTime: data.readBigUInt64LE(2).toString(),
        initPcAmount: (data.readBigUInt64LE(10) / BigInt(10 ** 0)).toString(),
        initCoinAmount: (data.readBigUInt64LE(18) / BigInt(10 ** 0)).toString(),
    };
}

async function processRaydiumLpTransaction(connection, signature) {
    try {
        const transactionDetails = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!transactionDetails) {
            console.error("No transaction details found for signature:", signature);
            return;
        }

        const message = transactionDetails.transaction.message;
        const accounts = message.staticAccountKeys
            ? message.staticAccountKeys.map((key) => key.toString())
            : message.accountKeys.map((key) => key.toString());

        const instructions = message.compiledInstructions || message.instructions;

        if (!instructions) {
            console.error("No instructions found in transaction");
            return;
        }

        console.log("Transaction Message:", message);
        console.log("Accounts:", accounts);

        for (const ix of instructions) {
            const programId = accounts[ix.programIdIndex];

            if (programId === RAYDIUM_AMM_PROGRAM_ID.toString() && ix.data.length > 0) {
                const accountIndices = ix.accounts || ix.accountKeyIndexes;

                if (!accountIndices) {
                    console.error("No account indices found in instruction");
                    continue;
                }

                const data = Buffer.from(ix.data, 'base64');
                const params = parseCreateAmmLpParams(data);

                // Core AMM accounts
                const mint0 = accounts[accountIndices[8]];
                const mint1 = accounts[accountIndices[9]];
                const lpTokenMint = accounts[accountIndices[7]];
                const deployer = accounts[accountIndices[17]];
                const poolId = accounts[accountIndices[4]];
                const baseVault = accounts[accountIndices[10]];
                const quoteVault = accounts[accountIndices[11]];
                const ammAuthority = accounts[accountIndices[5]];
                const ammTarget = accounts[accountIndices[13]];
                const ammOpenOrder = accounts[accountIndices[6]];

                // Remaining Serum market accounts
                const marketProgramId = accounts[accountIndices[15]];
                const marketId = accounts[accountIndices[16]];
                const marketBaseVault = accounts[accountIndices[18]];
                const marketQuoteVault = accounts[accountIndices[19]];
                const marketAuthority = accounts[accountIndices[20]];

                let tokenData = {
                    programId: new PublicKey(accounts[accountIndices[0]]).toString(),
                    ammId: new PublicKey(poolId).toString(),
                    ammAuthority: new PublicKey(ammAuthority).toString(),
                    ammOpenOrders: new PublicKey(ammOpenOrder).toString(),
                    lpMint: new PublicKey(lpTokenMint).toString(),
                    tokenAddress: new PublicKey(mint0).toString(),
                    solAddress: new PublicKey(mint1).toString(),
                    tokenVault: new PublicKey(baseVault).toString(),
                    solVault: new PublicKey(quoteVault).toString(),
                    ammTargetOrders: new PublicKey(ammTarget).toString(),
                    deployer: new PublicKey(deployer).toString(),

                    // Remaining Serum market data
                    marketProgramId: new PublicKey(marketProgramId).toString(),
                    marketId: new PublicKey(marketId).toString(),
                    marketBaseVault: new PublicKey(marketBaseVault).toString(),
                    marketQuoteVault: new PublicKey(marketQuoteVault).toString(),
                    marketAuthority: new PublicKey(marketAuthority).toString(),

                    systemProgramId: SYSTEM_PROGRAM_ID,
                    tokenProgramId: TOKEN_PROGRAM_ID_STR,
                    associatedTokenProgramId: ASSOCIATED_TOKEN_PROGRAM_ID_STR,
                    initPcAmount: params.initPcAmount,
                    initCoinAmount: params.initCoinAmount,
                    K: (BigInt(params.initPcAmount) * BigInt(params.initCoinAmount)).toString(),
                    V: (Math.min(Number(params.initPcAmount), Number(params.initCoinAmount)) / Math.max(Number(params.initPcAmount), Number(params.initCoinAmount))).toString()
                };

                tokenData = invertCoinAndPcMint(tokenData);
                await saveToMongo(tokenData);
                return tokenData;
            }
        }
    } catch (error) {
        if (error.message.includes("Cannot read properties of undefined (reading '_bn')")) {
            console.log("Encountered 'placeholder' error, ignoring transaction:", signature);
        } else {
            console.error("Error processing transaction:", error.message);
        }
    }
}

module.exports = {
    connectToDatabase,
    processRaydiumLpTransaction,
};