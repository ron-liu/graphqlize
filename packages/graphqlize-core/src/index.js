import type {Graphqlize} from './types'
import {taskDo, taskAll, taskOf, taskRejected} from './util'
import {getOption} from './option'
import {getAst} from './ast'
import {getRelationshipsFromAst} from './relationship'
import {defineSequelize, initSequelize, registerGetDbService, sync} from './db'
import {getModels, registerGetModelInfoService} from './model'
import {buildAndAddGetModelConnectorsServices} from './connector'
import {printJson} from "./util/misc";
import {addBuiltInModelServices} from "./inject";

export const graphqlizeT : Graphqlize = (option = {}) => taskDo(function *() {
		const validatedOption = yield getOption(option)
		
		const [db, ast] = yield taskAll([
			initSequelize(validatedOption),
			getAst(validatedOption)
		])
		
		const [, relationships, models] = yield taskAll([
			registerGetDbService(validatedOption, db),
			getRelationshipsFromAst(ast),
			getModels(ast, validatedOption)
		])
		
		yield taskAll([
			registerGetModelInfoService({option: validatedOption, models, relationships}),
			defineSequelize({db, relationships, models, option}),
			buildAndAddGetModelConnectorsServices({option: validatedOption, db, models}),
			addBuiltInModelServices({option: validatedOption, models, relationships})
		])
		
		return taskOf()
	})
	.orElse(x=>{
		console.log('error caught:', x)
		return taskRejected(x)
	})

const graphqlize = option => graphqlizeT(option).run().promise()

export default graphqlize
