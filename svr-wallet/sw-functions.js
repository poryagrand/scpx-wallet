// Distributed under AGPLv3 license: see /LICENSE for terms. Copyright 2019 Dominic Morris.

const _ = require('lodash')

const configWallet = require('../config/wallet')
const configExternal  = require('../config/wallet-external')
const opsWallet = require('../actions/wallet')
const walletExternal = require('../actions/wallet-external')
const utilsWallet = require('../utils')

const log = require('../cli-log')

//
// general wallet functions
//

module.exports = {
    
    // connects 3PBP sockets, and requests initial load for all assets in the current wallet
    walletConnect: (appWorker, store, p) => {
        log.cmd('walletConnect')

        return new Promise((resolve) => {
    
            appWorker.postMessage({ msg: 'INIT_WEB3_SOCKET', data: {} })
            appWorker.postMessage({ msg: 'INIT_INSIGHT_SOCKETIO', data: {} })
            
            const listener = function(event) {
                var input = utilsWallet.unpackWorkerResponse(event)
                if (input) {
                    const data = input.data
                    const msg = input.msg
                    if (msg === 'BLOCKBOOK_ISOSOCKETS_DONE') {
                        
                        log.info('BLOCKBOOK_ISOSOCKETS_DONE: data.symbolsConnected=', data.symbolsConnected)
                        log.info('BLOCKBOOK_ISOSOCKETS_DONE: data.symbolsNotConnected=', data.symbolsNotConnected)

                        const storeState = store.getState()
                        if (storeState.wallet && storeState.wallet.assets) {

                            // connect addr monitors & populate all assets
                            appWorker.postMessage({ msg: 'DISCONNECT_ADDRESS_MONITORS', data: { wallet: storeState.wallet } })
                            appWorker.postMessage({ msg: 'CONNECT_ADDRESS_MONITORS', data: { wallet: storeState.wallet } })

                            if (data.symbolsConnected.length > 0) {
                                log.info('BLOCKBOOK_ISOSOCKETS_DONE: triggering loadAllAsets...')

                                opsWallet.loadAllAssets({ bbSymbols_SocketReady: data.symbolsConnected, store })
                                .then(p => {
                                    resolve({ ok: true })
                                })

                            }
                        }
                        else {
                            resolve({ ok: false })  // ** load resiliance (experimenting) ** -- keep waiting here
                        }
                        
                        appWorker.removeEventListener('message', listener)  // ** load resiliance (experimenting) ** -- keep listening here
                    }
                }
            }
            appWorker.addEventListener('message', listener)
    
            appWorker.postMessage({ msg: 'INIT_BLOCKBOOK_ISOSOCKETS', data: { timeoutMs: configWallet.VOLATILE_SOCKETS_REINIT_SECS * 0.75 * 1000, walletFirstPoll: true } })
            appWorker.postMessage({ msg: 'INIT_GETH_ISOSOCKETS', data: {} })
            
            // volatile sockets reconnect / keep-alive timer
            log.info(`Setting volatile sockets reconnector...`)
            const globalScope = utilsWallet.getMainThreadGlobalScope()
            globalScope.volatileSockets_intId = setInterval(() => {
                if (globalScope.appWorker) {
                    try {
                        globalScope.appWorker.postMessage({ msg: 'INIT_BLOCKBOOK_ISOSOCKETS', data: { timeoutMs: configWallet.VOLATILE_SOCKETS_REINIT_SECS * 0.75 * 1000 } })
                        globalScope.appWorker.postMessage({ msg: 'INIT_GETH_ISOSOCKETS', data: {} })
                    }
                    catch(err) { // test complete - disconnect timing
                        utilsWallet.warn(err)
                    }
                }
            }, configWallet.VOLATILE_SOCKETS_REINIT_SECS * 1000)
    
        })
    },

    // dumps current wallet asset data
    walletDump: (appWorker, store, p) => {
        var { mpk, apk, symbol, txs, keys } = p
        log.cmd('walletDump')

        // extract filter symbol, if any
        var filterSymbol
        if (symbol && symbol.length > 0) {
            filterSymbol = symbol
        }

        // dump tx's, if specified
        var dumpTxs = false
        if (utilsWallet.isParamTrue(txs)) {
            dumpTxs = true  
        }

        // dump privkeys, if specified
        var dumpPrivKeys = false
        if (utilsWallet.isParamTrue(keys)) {
            dumpPrivKeys = true
        }
        
        const h_mpk = utilsWallet.pbkdf2(apk, mpk)

        // decrypt raw assets (private keys) from the store
        const wallet = store.getState().wallet
        var pt_rawAssets = utilsWallet.aesDecryption(apk, h_mpk, wallet.assetsRaw)
        if (!pt_rawAssets) return Promise.resolve({ err: `Decrypt failed - MPK is probably incorrect` })
        var pt_rawAssetsObj = JSON.parse(pt_rawAssets)
    
        // match privkeys to addresses by HD path in the displayable assets (unencrypted) store 
        var allPathKeyAddrs = []
        Object.keys(pt_rawAssetsObj).forEach(assetName => {
            pt_rawAssetsObj[assetName].accounts.forEach(account => {
                account.privKeys.forEach(privKey => {
                    var pathKeyAddr = {
                        assetName,
                        path: privKey.path,
                        privKey: privKey.privKey,
                    }
                    const meta = configWallet.walletsMeta[assetName]

                    if (filterSymbol === undefined || filterSymbol.toLowerCase() === meta.symbol.toLowerCase()) {
    
                        // get corresponding addr, lookup by HD path
                        const walletAsset = wallet.assets.find(p => p.symbol === meta.symbol)
                        const walletAddr = walletAsset.addresses.find(p => p.path === privKey.path)
        
                        pathKeyAddr.symbol = meta.symbol
                        pathKeyAddr.accountName = walletAddr.accountName
                        pathKeyAddr.addr = _.cloneDeep(walletAddr)
                        pathKeyAddr.addr.explorerPath = configExternal.walletExternal_config[meta.symbol].explorerPath(walletAddr.addr)

                        pathKeyAddr.addr.txCountConfirmed = pathKeyAddr.addr.txs.filter(p => p.block_no > 0).length
                        pathKeyAddr.addr.txCountUnconfirmed = pathKeyAddr.addr.txs.filter(p => !(p.block_no > 0)).length
                        pathKeyAddr.addr.utxoCount = pathKeyAddr.addr.utxos.length
                        if (!dumpTxs) {
                            delete pathKeyAddr.addr.txs
                            delete pathKeyAddr.addr.utxos
                        }
                        else {
                            pathKeyAddr.addr.txs.forEach(tx => {
                                tx.txExplorerPath = configExternal.walletExternal_config[meta.symbol].txExplorerPath(tx.txid)
                            })
                        }

                        if (!dumpPrivKeys) {
                            pathKeyAddr.privKey = undefined
                        }
                        
                        allPathKeyAddrs.push(pathKeyAddr)
                    }
                })
            })
        })
    
        utilsWallet.softNuke(pt_rawAssets)
        utilsWallet.softNuke(pt_rawAssetsObj)
    
        return new Promise((resolve) => {
            resolve({ ok: allPathKeyAddrs })
        })
    },

    // displays combined balances (for all addresses) 
    walletBalance: (appWorker, store, p) => {
        var { symbol } = p
        log.cmd('walletBalance')

        // validate
        const wallet = store.getState().wallet
        if (!utilsWallet.isParamEmpty(symbol)) { 
            const asset = wallet.assets.find(p => p.symbol.toLowerCase() === symbol.toLowerCase())
            if (!asset) return Promise.resolve({ err: `Invalid asset symbol "${symbol}"` })
        }

        const balances = wallet.assets
            .filter(p => utilsWallet.isParamEmpty(symbol) || p.symbol.toLowerCase() === symbol.toLowerCase())
            .map(asset => {
            const bal = walletExternal.get_combinedBalance(asset)
            return {
                symbol: asset.symbol,
                  conf: utilsWallet.toDisplayUnit(bal.conf, asset),
                unconf: utilsWallet.toDisplayUnit(bal.unconf, asset)
            }
        })
        return Promise.resolve({ ok: { balances } })
    }
}
