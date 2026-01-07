declare module 'backblaze-b2' {
    interface B2Config {
        applicationKeyId: string;
        applicationKey: string;
    }

    interface AuthorizeResponse {
        data: {
            downloadUrl: string;
            accountId: string;
            [key: string]: any;
        };
    }

    interface UploadUrlResponse {
        data: {
            uploadUrl: string;
            authorizationToken: string;
            accountId?: string;
            downloadUrl?: string;
            [key: string]: any;
        };
    }

    interface UploadFileResponse {
        data: {
            fileId: string;
            fileName: string;
            [key: string]: any;
        };
    }

    interface GetBucketResponse {
        data: {
            buckets: Array<{
                bucketId: string;
                bucketName: string;
                bucketInfo?: {
                    downloadUrl?: string;
                    [key: string]: any;
                };
                [key: string]: any;
            }>;
            [key: string]: any;
        };
    }

    interface ListFileNamesResponse {
        data: {
            files: Array<{
                fileId: string;
                fileName: string;
                [key: string]: any;
            }>;
            [key: string]: any;
        };
    }

    class B2 {
        constructor(config: B2Config);
        authorize(): Promise<AuthorizeResponse>;
        getUploadUrl(params: { bucketId: string }): Promise<UploadUrlResponse>;
        uploadFile(params: {
            uploadUrl: string;
            uploadAuthToken: string;
            fileName: string;
            data: Buffer;
            contentLength: number;
            contentType: string;
        }): Promise<UploadFileResponse>;
        getBucket(params: { bucketId: string }): Promise<GetBucketResponse>;
        listFileNames(params: {
            bucketId: string;
            startFileName: string;
            maxFileCount: number;
        }): Promise<ListFileNamesResponse>;
        deleteFileVersion(params: {
            fileId: string;
            fileName: string;
        }): Promise<any>;
    }

    export = B2;
}

