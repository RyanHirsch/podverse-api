import { config } from '~/config'
const { manticore } = config
const { domain, port, protocol } = manticore

const Manticoresearch = require('manticoresearch')

const client = new Manticoresearch.ApiClient()
client.basePath = `${protocol}://${domain}:${port}`

export const searchApi = new Manticoresearch.SearchApi(client)
