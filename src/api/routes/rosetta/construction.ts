import { addAsync, RouterWithAsync } from '@awaitjs/express';
import { address as btcAddress } from 'bitcoinjs-lib';
import * as BN from 'bn.js';
import {
  NetworkIdentifier,
  RosettaAccountIdentifier,
  RosettaConstructionDeriveResponse,
  RosettaConstructionHashRequest,
  RosettaConstructionHashResponse,
  RosettaConstructionMetadataResponse,
  RosettaConstructionPreprocessResponse,
  RosettaMaxFeeAmount,
  RosettaOperation,
  RosettaOptions,
  RosettaPublicKey,
  RosettaConstructionSubmitResponse,
  RosettaConstructionMetadataRequest,
  RosettaConstructionPayloadResponse,
  RosettaConstructionCombineRequest,
  RosettaConstructionCombineResponse,
  RosettaAmount,
  RosettaCurrency,
  RosettaTransaction,
} from '@blockstack/stacks-blockchain-api-types';
import {
  createMessageSignature,
  emptyMessageSignature,
  isSingleSig,
  makeSigHashPreSign,
  MessageSignature,
  BufferReader,
  deserializeTransaction,
  StacksTransaction,
  UnsignedTokenTransferOptions,
  makeUnsignedSTXTokenTransfer,
  TransactionSigner,
  AuthType,
  ChainID,
  makeUnsignedContractCall,
  UnsignedContractCallOptions,
  uintCV,
  tupleCV,
  bufferCV,
} from '@stacks/transactions';
import * as express from 'express';
import { StacksCoreRpcClient } from '../../../core-rpc/client';
import { DataStore, DbBlock } from '../../../datastore/common';
import { FoundOrNot, hexToBuffer, isValidC32Address, has0xPrefix } from '../../../helpers';
import { RosettaConstants, RosettaErrors, RosettaErrorsTypes } from '../../rosetta-constants';
import {
  bitcoinAddressToSTXAddress,
  getOperations,
  getOptionsFromOperations,
  getSigners,
  isDecimalsSupported,
  isSignedTransaction,
  isSymbolSupported,
  publicKeyToBitcoinAddress,
  rawTxToBaseTx,
  rawTxToStacksTransaction,
  getStacksNetwork,
  makePresignHash,
  verifySignature,
} from './../../../rosetta-helpers';
import { makeRosettaError, rosettaValidateRequest, ValidSchema } from './../../rosetta-validate';

export function createRosettaConstructionRouter(db: DataStore, chainId: ChainID): RouterWithAsync {
  const router = addAsync(express.Router());
  router.use(express.json());

  //construction/derive endpoint
  router.postAsync('/derive', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body, chainId);
    if (!valid.valid) {
      //TODO have to fix this and make error generic
      if (valid.error?.includes('should be equal to one of the allowed values')) {
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidCurveType]);
      }
      res.status(500).json(makeRosettaError(valid));
      return;
    }

    const publicKey: RosettaPublicKey = req.body.public_key;
    const network: NetworkIdentifier = req.body.network_identifier;

    if (has0xPrefix(publicKey.hex_bytes)) {
      publicKey.hex_bytes = publicKey.hex_bytes.replace('0x', '');
    }

    try {
      const btcAddress = publicKeyToBitcoinAddress(publicKey.hex_bytes, network.network);
      if (btcAddress === undefined) {
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidPublicKey]);
        return;
      }
      const stxAddress = bitcoinAddressToSTXAddress(btcAddress);

      const accountIdentifier: RosettaAccountIdentifier = {
        address: stxAddress,
      };
      const response: RosettaConstructionDeriveResponse = {
        account_identifier: accountIdentifier,
      };
      res.json(response);
    } catch (e) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidPublicKey]);
    }
  });

  //construction/preprocess endpoint
  router.postAsync('/preprocess', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body, chainId);
    if (!valid.valid) {
      res.status(500).json(makeRosettaError(valid));
      return;
    }

    const operations: RosettaOperation[] = req.body.operations;

    // Max operations should be 3 for one transaction
    if (operations.length > 3) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
      return;
    }

    if (!isSymbolSupported(req.body.operations)) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidCurrencySymbol]);
      return;
    }

    if (!isDecimalsSupported(req.body.operations)) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidCurrencyDecimals]);
      return;
    }

    const options = getOptionsFromOperations(req.body.operations);
    if (options == null) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
      return;
    }

    if (req.body.metadata) {
      if (req.body.metadata.gas_limit) {
        options.gas_limit = req.body.metadata.gas_limit;
      }

      if (req.body.metadata.gas_price) {
        options.gas_price = req.body.metadata.gas_price;
      }

      if (req.body.suggested_fee_multiplier) {
        options.suggested_fee_multiplier = req.body.suggested_fee_multiplier;
      }
    }

    if (req.body.max_fee) {
      const max_fee: RosettaMaxFeeAmount = req.body.max_fee[0];
      if (
        max_fee.currency.symbol === RosettaConstants.symbol &&
        max_fee.currency.decimals === RosettaConstants.decimals
      ) {
        options.max_fee = max_fee.value;
      } else {
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidFee]);
        return;
      }
    }

    let transaction: StacksTransaction;
    switch (options.type) {
      case 'token_transfer':
        // dummy transaction to calculate size
        const dummyTokenTransferTx: UnsignedTokenTransferOptions = {
          recipient: options.token_transfer_recipient_address as string,
          amount: new BN(options.amount as string),
          // We don't know the fee yet but need a placeholder
          fee: new BN(0),
          // placeholder public key
          publicKey: '000000000000000000000000000000000000000000000000000000000000000000',
          network: getStacksNetwork(),
          // We don't know the non yet but need a placeholder
          nonce: new BN(0),
        };

        transaction = await makeUnsignedSTXTokenTransfer(dummyTokenTransferTx);
        break;
      case 'stacking':
        // dummy transaction to calculate size
        const dummyPoxAddress = '1Xik14zRm29UsyS6DjhYg4iZeZqsDa8D3';
        const { version, hash } = btcAddress.fromBase58Check(dummyPoxAddress);
        const versionBuffer = bufferCV(new BN(version, 10).toBuffer());
        const hashbytes = bufferCV(hash);
        const poxAddressCV = tupleCV({
          hashbytes,
          version: versionBuffer,
        });
        if (!options.amount) {
          res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
          return;
        }
        const dummyStackingTx: UnsignedContractCallOptions = {
          contractAddress: 'ST000000000000000000002AMW42H',
          contractName: 'pox',
          functionName: 'stack-stx',
          publicKey: '000000000000000000000000000000000000000000000000000000000000000000',
          functionArgs: [uintCV(options.amount), poxAddressCV, uintCV(0), uintCV(0)],
          validateWithAbi: true,
          network: getStacksNetwork(),
        };
        transaction = await makeUnsignedContractCall(dummyStackingTx);
        break;
      default:
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
        return;
    }

    const unsignedTransaction = transaction.serialize();

    options.size = unsignedTransaction.length;

    const rosettaPreprocessResponse: RosettaConstructionPreprocessResponse = {
      options,
      required_public_keys: [
        {
          address: options.sender_address as string,
        },
      ],
    };
    res.json(rosettaPreprocessResponse);
  });

  //construction/metadata endpoint
  router.postAsync('/metadata', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body, chainId);
    if (!valid.valid) {
      res.status(500).json(makeRosettaError(valid));
      return;
    }

    const request: RosettaConstructionMetadataRequest = req.body;
    const options: RosettaOptions = req.body.options;

    if (options?.sender_address && !isValidC32Address(options.sender_address)) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidSender]);
      return;
    }
    if (options?.symbol !== RosettaConstants.symbol) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidCurrencySymbol]);
      return;
    }

    if (!options?.fee && options?.size === undefined) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.missingTransactionSize]);
      return;
    }

    let response = {} as RosettaConstructionMetadataResponse;
    switch (options.type) {
      case 'token_transfer':
        const recipientAddress = options.token_transfer_recipient_address;
        if (options?.decimals !== RosettaConstants.decimals) {
          res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidCurrencyDecimals]);
          return;
        }

        if (recipientAddress == null || !isValidC32Address(recipientAddress)) {
          res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidRecipient]);
          return;
        }
        break;
      case 'stacking':
        // Getting stacking info
        const poxInfo = await new StacksCoreRpcClient().getPox();
        const coreInfo = await new StacksCoreRpcClient().getInfo();
        const contractInfo = poxInfo.contract_id.split('.');
        options.contract_address = contractInfo[0];
        options.contract_name = contractInfo[1];
        // Adding 3 blocks to provide a buffer for transaction to confirm
        options.burn_block_height = coreInfo.burn_block_height + 3;
        break;
      default:
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidTransactionType]);
        return;
    }

    if (!request.public_keys || request.public_keys.length != 1) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidPublicKey]);
      return;
    }

    const publicKey: RosettaPublicKey = request.public_keys[0];

    if (has0xPrefix(publicKey.hex_bytes)) {
      publicKey.hex_bytes = publicKey.hex_bytes.replace('0x', '');
    }

    let stxAddress;
    try {
      const btcAddress = publicKeyToBitcoinAddress(
        publicKey.hex_bytes,
        request.network_identifier.network
      );
      if (btcAddress === undefined) {
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidPublicKey]);
        return;
      }
      stxAddress = bitcoinAddressToSTXAddress(btcAddress);

      if (stxAddress !== options.sender_address) {
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidPublicKey]);
        return;
      }
    } catch (e) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidPublicKey]);
      return;
    }

    // Getting nonce info
    const accountInfo = await new StacksCoreRpcClient().getAccount(stxAddress);
    const nonce = accountInfo.nonce;

    let recentBlockHash = undefined;
    const blockQuery: FoundOrNot<DbBlock> = await db.getCurrentBlock();
    if (blockQuery.found) {
      recentBlockHash = blockQuery.result.block_hash;
    }

    response = {
      metadata: {
        ...req.body.options,
        account_sequence: nonce,
        recent_block_hash: recentBlockHash,
      },
    };

    let feeValue: string;
    // Getting fee info if not operation fee was given in /preprocess
    if (!options?.fee) {
      const feeInfo = await new StacksCoreRpcClient().getEstimatedTransferFee();
      if (feeInfo === undefined || feeInfo === '0') {
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidFee]);
        return;
      }
      feeValue = (BigInt(feeInfo) * BigInt(options.size)).toString();
      const currency: RosettaCurrency = {
        symbol: RosettaConstants.symbol,
        decimals: RosettaConstants.decimals,
      };

      const fee: RosettaAmount = {
        value: feeValue,
        currency,
      };

      response.suggested_fee = [fee];
    }

    res.json(response);
  });

  //construction/hash endpoint
  router.postAsync('/hash', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body, chainId);
    if (!valid.valid) {
      res.status(500).json(makeRosettaError(valid));
      return;
    }

    const request: RosettaConstructionHashRequest = req.body;

    if (!has0xPrefix(request.signed_transaction)) {
      request.signed_transaction = '0x' + request.signed_transaction;
    }

    let buffer: Buffer;
    try {
      buffer = hexToBuffer(request.signed_transaction);
    } catch (error) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidTransactionString]);
      return;
    }

    const transaction = deserializeTransaction(BufferReader.fromBuffer(buffer));
    const hash = transaction.txid();

    if (!transaction.auth.spendingCondition) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.transactionNotSigned]);
      return;
    }
    if (isSingleSig(transaction.auth.spendingCondition)) {
      /**Single signature Transaction has an empty signature, so the transaction is not signed */
      if (
        !transaction.auth.spendingCondition.signature.data ||
        emptyMessageSignature().data === transaction.auth.spendingCondition.signature.data
      ) {
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.transactionNotSigned]);
        return;
      }
    } else {
      /**Multi-signature transaction does not have signature fields thus the transaction not signed */
      if (transaction.auth.spendingCondition.fields.length === 0) {
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.transactionNotSigned]);
        return;
      }
    }

    const hashResponse: RosettaConstructionHashResponse = {
      transaction_identifier: {
        hash: '0x' + hash,
      },
    };
    res.status(200).json(hashResponse);
  });

  //construction/parse endpoint
  router.postAsync('/parse', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body, chainId);
    if (!valid.valid) {
      res.status(500).json(makeRosettaError(valid));
      return;
    }
    let inputTx = req.body.transaction;
    const signed = req.body.signed;

    if (!has0xPrefix(inputTx)) {
      inputTx = '0x' + inputTx;
    }

    const transaction = rawTxToStacksTransaction(inputTx);
    const checkSigned = isSignedTransaction(transaction);
    if (signed != checkSigned) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidParams]);
      return;
    }
    try {
      const operations = getOperations(rawTxToBaseTx(inputTx));
      let response;
      if (signed) {
        response = {
          operations: operations,
          account_identifier_signers: getSigners(transaction),
        };
      } else {
        response = {
          operations: operations,
        };
      }
      res.json(response);
    } catch (error) {
      console.error(error);
    }
  });

  //construction/submit endpoint
  router.postAsync('/submit', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body, chainId);
    if (!valid.valid) {
      res.status(500).json(makeRosettaError(valid));
      return;
    }
    let transaction = req.body.signed_transaction;
    let buffer: Buffer;

    if (!has0xPrefix(transaction)) {
      transaction = '0x' + transaction;
    }

    try {
      buffer = hexToBuffer(transaction);
    } catch (error) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidTransactionString]);
      return;
    }
    try {
      const submitResult = await new StacksCoreRpcClient().sendTransaction(buffer);
      const response: RosettaConstructionSubmitResponse = {
        transaction_identifier: {
          hash: submitResult.txId,
        },
      };
      res.status(200).json(response);
    } catch (e) {
      const err = RosettaErrors[RosettaErrorsTypes.invalidTransactionString];
      err.details = {
        message: e.message,
      };
      res.status(500).json(err);
    }
  });

  //construction/payloads endpoint
  router.postAsync('/payloads', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body, chainId);
    if (!valid.valid) {
      res.status(500).json(makeRosettaError(valid));
      return;
    }

    const options = getOptionsFromOperations(req.body.operations);
    if (options == null) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
      return;
    }

    const amount = options.amount;
    if (!amount) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidAmount]);
      return;
    }

    if (!options.fee || typeof options.fee !== 'string') {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidFees]);
      return;
    }
    const fee: string = options.fee;

    const publicKeys: RosettaPublicKey[] = req.body.public_keys;
    if (!publicKeys) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.emptyPublicKey]);
      return;
    }

    const recipientAddress = options.token_transfer_recipient_address;
    if (!recipientAddress) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidRecipient]);
      return;
    }
    const senderAddress = options.sender_address;

    if (!senderAddress) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidSender]);
      return;
    }

    const accountInfo = await new StacksCoreRpcClient().getAccount(senderAddress);
    let nonce = new BN(0);

    if ('metadata' in req.body && 'account_sequence' in req.body.metadata) {
      nonce = new BN(req.body.metadata.account_sequence);
    } else if (accountInfo.nonce) {
      nonce = new BN(accountInfo.nonce);
    }

    if (publicKeys.length !== 1) {
      //TODO support multi-sig in the future.
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.needOnePublicKey]);
      return;
    }

    if (publicKeys[0].curve_type !== 'secp256k1') {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidCurveType]);
      return;
    }

    if (has0xPrefix(publicKeys[0].hex_bytes)) {
      publicKeys[0].hex_bytes = publicKeys[0].hex_bytes.slice(2);
    }

    let transaction: StacksTransaction;
    switch (options.type) {
      case 'token_transfer':
        // signel signature
        const tokenTransferOptions: UnsignedTokenTransferOptions = {
          recipient: recipientAddress,
          amount: new BN(amount),
          fee: new BN(fee),
          publicKey: publicKeys[0].hex_bytes,
          network: getStacksNetwork(),
          nonce: nonce,
        };

        transaction = await makeUnsignedSTXTokenTransfer(tokenTransferOptions);
        break;
      case 'stacking':
        const poxBTCAddress = publicKeyToBitcoinAddress(
          publicKeys[0].hex_bytes,
          req.body.network_identifier.network
        );
        if (!poxBTCAddress) {
          res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidPublicKey]);
          return;
        }
        const { version, hash } = btcAddress.fromBase58Check(poxBTCAddress);
        const versionBuffer = bufferCV(new BN(version, 10).toBuffer());
        const hashbytes = bufferCV(hash);
        const poxAddressCV = tupleCV({
          hashbytes,
          version: versionBuffer,
        });
        if (!options.amount) {
          res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
          return;
        }
        if (!options.contract_address) {
          res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
          return;
        }
        if (!options.contract_name) {
          res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
          return;
        }
        if (!options.burn_block_height) {
          res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
          return;
        }
        if (!options.number_of_cycles) {
          res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
          return;
        }
        const stackingTx: UnsignedContractCallOptions = {
          contractAddress: options.contract_address,
          contractName: options.contract_name,
          functionName: 'stack-stx',
          publicKey: publicKeys[0].hex_bytes,
          functionArgs: [
            uintCV(options.amount),
            poxAddressCV,
            uintCV(options.burn_block_height),
            uintCV(options.number_of_cycles),
          ],
          validateWithAbi: true,
          network: getStacksNetwork(),
        };
        transaction = await makeUnsignedContractCall(stackingTx);
        break;
      default:
        res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidOperation]);
        return;
    }

    const unsignedTransaction = transaction.serialize();

    const signer = new TransactionSigner(transaction);

    const prehash = makeSigHashPreSign(signer.sigHash, AuthType.Standard, new BN(fee), nonce);
    const accountIdentifier: RosettaAccountIdentifier = {
      address: senderAddress,
    };
    const response: RosettaConstructionPayloadResponse = {
      unsigned_transaction: '0x' + unsignedTransaction.toString('hex'),
      payloads: [
        {
          address: senderAddress,
          account_identifier: accountIdentifier,
          hex_bytes: prehash,
          signature_type: 'ecdsa_recovery',
        },
      ],
    };
    res.json(response);
  });

  //construction/combine endpoint
  router.postAsync('/combine', async (req, res) => {
    const valid: ValidSchema = await rosettaValidateRequest(req.originalUrl, req.body, chainId);
    if (!valid.valid) {
      res.status(500).json(makeRosettaError(valid));
      return;
    }
    const combineRequest: RosettaConstructionCombineRequest = req.body;
    const signatures = combineRequest.signatures;

    if (!has0xPrefix(combineRequest.unsigned_transaction)) {
      combineRequest.unsigned_transaction = '0x' + combineRequest.unsigned_transaction;
    }

    if (signatures.length === 0) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.noSignatures]);
      return;
    }

    let unsigned_transaction_buffer: Buffer;
    let transaction: StacksTransaction;

    try {
      unsigned_transaction_buffer = hexToBuffer(combineRequest.unsigned_transaction);
      transaction = deserializeTransaction(BufferReader.fromBuffer(unsigned_transaction_buffer));
    } catch (e) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidTransactionString]);
      return;
    }

    if (signatures.length !== 1)
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.needOnlyOneSignature]);

    if (signatures[0].public_key.curve_type !== 'secp256k1') {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidCurveType]);
      return;
    }
    const preSignHash = makePresignHash(transaction);
    if (!preSignHash) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidTransactionString]);
      return;
    }

    let newSignature: MessageSignature;

    try {
      /**
       * the elliptic library produces signatures that aren't in an "allowed" format
       * it preapend v (i.e 01) while it should append it at the end, to incorporate that rotate
       * the signature to match the elipcitc library
       * Discussion here: https://github.com/coinbase/rosetta-sdk-go/issues/201
       */
      const hash = signatures[0].hex_bytes.slice(128) + signatures[0].hex_bytes.slice(0, -2);
      newSignature = createMessageSignature(hash);
    } catch (error) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.invalidSignature]);
      return;
    }

    if (has0xPrefix(signatures[0].public_key.hex_bytes)) {
      signatures[0].public_key.hex_bytes = signatures[0].public_key.hex_bytes.slice(2);
    }

    if (
      !verifySignature(
        signatures[0].signing_payload.hex_bytes,
        signatures[0].public_key.hex_bytes,
        newSignature
      )
    ) {
      res.status(500).json(RosettaErrors[RosettaErrorsTypes.signatureNotVerified]);
    }

    if (transaction.auth.spendingCondition && isSingleSig(transaction.auth.spendingCondition)) {
      transaction.auth.spendingCondition.signature = newSignature;
    } else {
      //support multi-sig
    }

    const serializedTx = transaction.serialize().toString('hex');

    const combineResponse: RosettaConstructionCombineResponse = {
      signed_transaction: '0x' + serializedTx,
    };

    res.status(200).json(combineResponse);
  });

  return router;
}
