// @flow
import {_TypeModel as FileDataDataGetTypModel, createFileDataDataGet} from "../../entities/tutanota/FileDataDataGet"
import {addParamsToUrl, restClient} from "../rest/RestClient"
import {encryptAndMapToLiteral, encryptBytes, resolveSessionKey} from "../crypto/CryptoFacade"
import {aes128Decrypt} from "../crypto/Aes"
import {_TypeModel as FileTypeModel} from "../../entities/tutanota/File"
import {neverNull} from "../../common/utils/Utils"
import type {LoginFacade} from "./LoginFacade"
import {createFileDataDataPost} from "../../entities/tutanota/FileDataDataPost"
import {_service} from "../rest/ServiceRestClient"
import {FileDataReturnPostTypeRef} from "../../entities/tutanota/FileDataReturnPost"
import {GroupType} from "../../common/TutanotaConstants"
import {random} from "../crypto/Randomizer"
import {_TypeModel as FileDataDataReturnTypeModel} from "../../entities/tutanota/FileDataDataReturn"
import {HttpMethod, MediaType} from "../../common/EntityFunctions"
import {assertWorkerOrNode, getHttpOrigin, Mode} from "../../Env"
import {aesDecryptFile, aesEncryptFile} from "../../../native/AesApp"
import {handleRestError} from "../../common/error/RestError"
import {fileApp} from "../../../native/FileApp"
import {createDataFile} from "../../common/DataFile"

assertWorkerOrNode()

export class FileFacade {
	_login: LoginFacade;

	constructor(login: LoginFacade) {
		this._login = login
	}

	downloadFileContent(file: TutanotaFile): Promise<DataFile | FileReference> {
		let requestData = createFileDataDataGet()
		requestData.file = file._id
		requestData.base64 = false

		return resolveSessionKey(FileTypeModel, file).then(sessionKey => {
			return encryptAndMapToLiteral(FileDataDataGetTypModel, requestData, null).then(entityToSend => {
				let headers = this._login.createAuthHeaders()
				headers['v'] = FileDataDataGetTypModel.version
				let body = JSON.stringify(entityToSend)
				if (env.mode === Mode.App) {
					let queryParams = {'_body': encodeURIComponent(body)}
					let url = addParamsToUrl(getHttpOrigin() + "/rest/tutanota/filedataservice", queryParams)

					return fileApp.download(url, file.name, headers).then(({statusCode, statusMessage, encryptedFileUri}) => {
						return ((statusCode === 200 && encryptedFileUri != null)
							? aesDecryptFile(neverNull(sessionKey), encryptedFileUri).then(decryptedFileUrl => {
								return {
									_type: 'FileReference',
									name: file.name,
									mimeType: file.mimeType,
									location: decryptedFileUrl,
									size: file.size
								}
							})
							: Promise.reject(handleRestError(statusCode, `${statusMessage} | GET ${url} failed to natively download attachment`)))
							.finally(() => encryptedFileUri != null && fileApp.deleteFile(encryptedFileUri)
							                                                  .catch(() => console.log("Failed to delete encrypted file", encryptedFileUri)))
					})
				} else {
					return restClient.request("/rest/tutanota/filedataservice", HttpMethod.GET, {}, headers, body, MediaType.Binary)
					                 .then(data => {
						                 return createDataFile(file, aes128Decrypt(neverNull(sessionKey), data))
					                 })
				}
			})
		})
	}

	uploadFileData(dataFile: DataFile, sessionKey: Aes128Key): Promise<Id> {
		let encryptedData = encryptBytes(sessionKey, dataFile.data)
		let fileData = createFileDataDataPost()
		fileData.size = dataFile.data.byteLength.toString()
		fileData.group = this._login.getGroupId(GroupType.Mail) // currently only used for attachments
		return _service("filedataservice", HttpMethod.POST, fileData, FileDataReturnPostTypeRef, null, sessionKey)
			.then(fileDataPostReturn => {
				// upload the file content
				let fileDataId = fileDataPostReturn.fileData
				let headers = this._login.createAuthHeaders()
				headers['v'] = FileDataDataReturnTypeModel.version
				return restClient.request("/rest/tutanota/filedataservice", HttpMethod.PUT,
					{fileDataId: fileDataId}, headers, encryptedData, MediaType.Binary)
				                 .then(() => fileDataId)
			})
	}

	/**
	 * Does not cleanup uploaded files. This is a responsibility of the caller
	 */
	uploadFileDataNative(fileReference: FileReference, sessionKey: Aes128Key): Promise<Id> {
		return aesEncryptFile(sessionKey, fileReference.location, random.generateRandomData(16))
			.then(encryptedFileInfo => {
				let fileData = createFileDataDataPost()
				fileData.size = encryptedFileInfo.unencSize.toString()
				fileData.group = this._login.getGroupId(GroupType.Mail) // currently only used for attachments
				return _service("filedataservice", HttpMethod.POST, fileData, FileDataReturnPostTypeRef, null, sessionKey)
					.then(fileDataPostReturn => {
						let fileDataId = fileDataPostReturn.fileData
						let headers = this._login.createAuthHeaders()
						headers['v'] = FileDataDataReturnTypeModel.version
						let url = addParamsToUrl(getHttpOrigin() + "/rest/tutanota/filedataservice", {fileDataId})
						return fileApp.upload(encryptedFileInfo.uri, url, headers).then(({statusCode, statusMessage}) => {
							if (statusCode === 200) {
								return fileDataId;
							} else {
								throw handleRestError(statusCode,
									`${statusMessage} | PUT ${url} failed to natively upload attachment`)
							}
						})
					})
			})

	}
}
