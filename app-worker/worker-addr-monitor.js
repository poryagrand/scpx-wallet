
const configExternal = require('../config/wallet-external')

const workerAddrMemPool = require('./worker-addr-mempool')

const utilsWallet = require('../utils')

module.exports = {
    // setup/teardown address monitoring 
    addressMonitors_Sub_Unsub: (wallet, sub) => {
        if (wallet && wallet.assets) {
            if (sub) { // subscribe
                for (const asset of wallet.assets) {
                    
                    if (asset.symbol === 'EOS') {
                        ; // todo
                    }
                    else if (utilsWallet.isERC20(asset)) {
                        ; // nop - we get through eth addr-monitor
                    }
                    else {
                        if (asset.use_BBv3 || asset.symbol === 'ETH') {
                            subAddr_Blockbook(wallet, asset)
                        }
                        else {
                            subAddr_Insight(asset)
                        }
                    }
                }
            }
            else { // unsubscribe
                for (const asset of wallet.assets) {
                    if (asset.symbol === 'EOS') {
                        ; // todo
                    }
                    else if (utilsWallet.isERC20(asset)) {
                        ; // nop 
                    }
                    else {
                        if (asset.use_BBv3 || asset.symbol === 'ETH') {
                            unsubAddr_Blockbook(asset.symbol)
                        }
                        else {
                            unsubAddr_Insight(asset.symbol)
                        }
                    }
                }
            }
        }
    },
}

function 
subAddr_Blockbook(wallet, asset) {
    const ownAddresses = asset.addresses.map(p => { return p.addr })
    
    //var socket = worker.get_BlockbookSocketIo(asset)
    var socket = self.get_BlockbookSocketIo(asset)

    if (socket === undefined) { utilsWallet.warn(`appWorker >> ${self.workerId} subAddr_Blockbook ${asset.symbol}: no socket setup!`); return }
    try {
        
        // subscribe addr monitor
        socket.emit('subscribe', "bitcoind/addresstxid", ownAddresses, (result) => {})
        utilsWallet.debug(`appWorker >> ${self.workerId} subAddr_Blockbook, ownAddresses=`, ownAddresses.join(','), { logServerConsole: true })

        // callback
        socket.on("bitcoind/addresstxid", function (data) {
            if (data && data.txid) {
                const txid = data.txid
                //const addr = data.address

                if (self.blockbookAddrTxs.some(p => { return p === txid })) {
                    utilsWallet.log(`appWorker >> ${self.workerId} *** subAddr_Blockbook - new TX - ${asset.symbol} *** - ignoring server dupe send: already processed this txid! data=`, data)
                }
                else {
                    self.blockbookAddrTxs.push(txid)

                    if (asset.symbol === 'ETH') {
                        //utilsWallet.log('DBG1 - got addr-monitor callback, txid=', txid)
                        
                        //utilsWallet.log(`appWorker >> ${self.workerId} bitcoind/addresstxid ETH data - requesting ASSET_REFRESH_ADDR_MONITOR`)
                        //postMessage({ msg: 'REQUEST_STATE', status: 'REQ', data: { stateItem: 'ASSET', stateKey: asset.symbol, context: 'ASSET_REFRESH_ADDR_MONITOR' } })

                        // as below for SW; BB mempool is simply not reliably in sync with its bitcoind/addresstxid callbacks
                        // so, we query web3 directly for the txid and process with mempool_process_EthTx();
                        // double and tripple checked: the BB mempool is definitely lagging, i.e. we get bitcoind/addresstxid notifications
                        // but BB *doesn't* report the tx in its mempool (sometimes it does, sometimes it doesn't until the next block) -- this lines up
                        // with its status page intermitently reporting mempool is not in sync for ETH

                        utilsWallet.log(`appWorker >> ${self.workerId} bitcoind/addresstxid data - ${asset.symbol} - web3 getTx... txid=`, txid)
                        const web3 = self.ws_web3 // singleton socket instance
                        if (!web3) {
                            utilsWallet.error(`appWorker >> ${self.workerId} mempool_GetTx - ${asset.symbol} - singleton web3 socket provider is not available!`); return
                        }
                        else {
                            web3.eth.getTransaction(txid)
                            .then((tx) => {
                                const erc20s = Object.keys(configExternal.erc20Contracts).map(p => { return { erc20_addr: configExternal.erc20Contracts[p], symbol: p } })
                                const erc20 = erc20s.find(p => { return p.erc20_addr.toLowerCase() === tx.to.toLowerCase() })
                                const weAreSender = ownAddresses.some(ownAddr => ownAddr.toLowerCase() === tx.from.toLowerCase())
                                if (!weAreSender) { // no need to do this for our own sent tx's (we push the local_tx ourselves); but looks like we could do if we wanted or needed to
                                    workerAddrMemPool.mempool_process_EthTx(web3, wallet, asset, txid, tx, weAreSender, erc20)
                                }
                            })
                        }

                        utilsWallet.log(`appWorker >> ${self.workerId} bitcoind/addresstxid ETH data - requesting ASSET_REFRESH_ADDR_MONITOR`)
                        postMessage({ msg: 'REQUEST_STATE', status: 'REQ', data: { stateItem: 'ASSET', stateKey: asset.symbol, context: 'ASSET_REFRESH_ADDR_MONITOR' } })
                    }
                    else {
                        utilsWallet.log(`appWorker >> ${self.workerId} bitcoind/addresstxid data - ${asset.symbol} - BB getDetailedTransaction... txid=`, txid)

                        // query blockbook for full tx details (see https://btc1.trezor.io/static/test.html for full blockbook socket interface)
                        socket.send({ method: 'getDetailedTransaction', params: [txid] }, (bb_txData) => {
                            if (bb_txData && bb_txData.result) {
                                // trigger refresh: we will walk the mempool utxo list and record the mempool tx in local_txs[]
                                //postMessage({ msg: 'REQUEST_STATE', status: 'REQ', data: { stateItem: 'ASSET', stateKey: asset.symbol, context: 'ASSET_REFRESH_ADDR_MONITOR' } })

                                // this works much more reliably, i.e. writing the local_tx directly instead of 
                                // requesting a full asset refresh and requiring its mempool read to pick up the tx
                                const tx = bb_txData.result
                                const ownAddresses = asset.addresses.map(p => { return p.addr })
                                const weAreSender = tx.inputs.some(p => { return ownAddresses.some(p2 => p2 === p.address) })
                                const mempool_spent_txids = []
                                workerAddrMemPool.mempool_process_Btc_SW(wallet, asset, txid, tx, weAreSender, ownAddresses, mempool_spent_txids)
                            }
                        })
                    }
                }
            }
        })
    }
    catch (err) {
        utilsWallet.error(`### appWorker >> ${self.workerId} subAddr_Blockbook ${asset.symbol}, err=`, err)
        utilsWallet.trace()
    }
}

// insight addr sub's -- we are sharing the insight sockets used for block and pending tx polling
function subAddr_Insight(asset) {
    utilsWallet.debug(`appWorker >> ${self.workerId} subAddr_Insight ${asset.symbol}...`)
    const ownAddresses = asset.addresses.map(p => { return p.addr })
    var socket = self.insightSocketIos[asset.symbol]
    if (socket === undefined) { utilsWallet.warn(`appWorker >> ${self.workerId} subAddr_Insight ${asset.symbol}: no socket setup!`); return }
    try {
        // subscribe address mintor
        socket.emit('subscribe', 'bitcoind/addresstxid', ownAddresses)
        utilsWallet.log(`appWorker >> ${self.workerId} subAddr_Insight, ownAddresses=`, ownAddresses.join(','), { logServerConsole: true })

        // callback
        socket.on('bitcoind/addresstxid', function (data) {
            if (data && data.txid) {
                const txid = data.txid
                //const addr = data.address

                if (self.insightAddrTxs.some(p => { return p === txid })) {
                    utilsWallet.warn(`appWorker >> ${self.workerId} *** subscribe_InsightSocket - new TX - ${asset.symbol} *** - ignoring server dupe send: already processed this txid! data=`, data)
                }
                else {
                    self.insightAddrTxs.push(txid)

                    utilsWallet.log(`appWorker >> ${self.workerId} *** subscribe_InsightSocket - new TX - ${asset.symbol} *** data=`, data)
                    postMessage({ msg: 'REQUEST_STATE', status: 'REQ', data: { stateItem: 'ASSET', stateKey: asset.symbol, context: 'ASSET_REFRESH_ADDR_MONITOR' } })
                }
            }
        })
    }
    catch (err) {
        utilsWallet.error(`### appWorker >> ${self.workerId} subAddr_Insight ${asset.symbol}, err=`, err)
        utilsWallet.trace()
    }
}

function unsubAddr_Blockbook(assetSymbol) {
    utilsWallet.debug(`appWorker >> ${self.workerId} unsubAddr_Blockbook ${assetSymbol}...`)
    var socket = self.blockbookSocketIos[assetSymbol]
    if (socket === undefined) { utilsWallet.warn(`appWorker >> ${self.workerId} unsubAddr_Blockbook ${assetSymbol}: no socket setup!`); return }
    try {
        socket.removeAllListeners("bitcoind/addresstxid")
    }
    catch (err) { utilsWallet.error(`### appWorker >> ${self.workerId} unsubAddr_Blockbook ${assetSymbol}, err=`, err) }
}

function unsubAddr_Insight(assetSymbol) {
    utilsWallet.debug(`appWorker >> ${self.workerId} unsubAddr_Insight ${assetSymbol}...`)
    var socket = self.insightSocketIos[assetSymbol]
    if (socket === undefined) { utilsWallet.warn(`appWorker >> ${self.workerId} unsubAddr_Insight ${assetSymbol}: no socket setup!`); return }
    try {
        socket.emit('unsubscribe', 'bitcoind/addresstxid')
    }
    catch (err) { utilsWallet.error(`### appWorker >> ${self.workerId} unsubAddr_Insight ${assetSymbol}, err=`, err) }
}