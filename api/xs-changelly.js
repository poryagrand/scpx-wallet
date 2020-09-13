// Distributed under AGPLv3 license: see /LICENSE for terms. Copyright 2019-2020 Dominic Morris.

const axios = require('axios')
const { axiosApi } = require('./api')

module.exports = { 
    toXsSymbol: (symbol) => { 
        return symbol.toUpperCase() === 'BTC_SEG' || symbol.toUpperCase() === 'BTC_SEG2' ? 'btc' 
             : symbol.toUpperCase() === 'BCHABC' ? 'bch'
             : symbol.toUpperCase() === 'USDT' ? 'usdt20'
             : symbol.toLowerCase()
    },

    xs_changelly_Sign: (rpcParams) => {
        const req = { rpc_params: rpcParams }

        //console.log('xs_changelly_Sign POST: ' + JSON.stringify(req, 2, null))
        
        //axiosRetry(axios, CONST.AXIOS_RETRY_EXTERNAL)
        return axiosApi.post(`xs/c/sign`, req)
        .then(res => {
            //console.log('xs_changelly_Sign POST, ret=' + JSON.stringify(res, 2, null))
            if (res && res.data) {
                return res.data
            }
            else  {
                console.error('## xs_changelly_Sign POST, no data')
                return null
            }
        })
        .catch(err => {
            console.error('## xs_changelly_Sign POST, err= ', err)
            return null
        })    
    }
}