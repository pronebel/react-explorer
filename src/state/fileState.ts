import { observable, action, runInAction } from "mobx";
import { FsApi, Fs, getFS, File, ICredentials, needsConnection } from "../services/Fs";
import { Deferred } from '../utils/deferred';
import i18next from '../locale/i18n';
import { shell, ipcRenderer } from 'electron';
import * as process from 'process';

const isWin = process.platform === "win32";

type TStatus = 'blank' | 'busy' | 'ok' | 'login' | 'offline';

export class FileState {
    /* observable properties start here */
    @observable
    path: string = '';

    previousPath: string;

    readonly files = observable<File>([]);

    readonly selected = observable<File>([]);

    @observable
    server: string = '';

    credentials: ICredentials;

    @observable
    status: TStatus;

    @observable
    active = false;

    // history stuff
    history = observable<string>([]);
    @observable
    current: number = -1;

    @action
    setStatus(status: TStatus) {
        this.status = status;
    }

    @action
    addPathToHistory(path: string) {
        const keep = this.history.slice(0, this.current + 1);
        this.history.replace(keep.concat([path]));
        this.current++;
    }

    @action
    navHistory(dir = -1, force = false) {
        if (!this.history.length) {
            console.warn('attempting to nav in empty history');
            return;
        }

        const history = this.history;
        const current = this.current;
        const length = history.length;
        let newCurrent = current + dir;

        if (newCurrent < 0) {
            newCurrent = 0;
        } else if (newCurrent >= length) {
            newCurrent = length - 1;
        }

        this.current = newCurrent;

        const path = history[current + dir];
        if (path !== this.path || force) {
            console.log('opening path from history', path);
            this.cd(path, '', true, true);
        } else {
            console.warn('preventing endless loop');
        }
    }
    // /history

    /* fs API */
    private api: FsApi;
    private fs: Fs;
    private prevFs: Fs;
    private prevApi: FsApi;
    private prevServer: string;

    private loginDefer: Deferred<any>;

    constructor(path: string) {
        this.path = path;
        this.getNewFS(path);
    }

    private saveContext() {
        this.prevServer = this.server;
        this.prevApi = this.api;
        this.prevFs = this.fs;
    }

    private restoreContext() {
        this.freeFsEvents();
        this.api = this.prevApi;
        this.bindFsEvents();
        this.fs = this.prevFs;
        this.server = this.prevServer;
    }

    private bindFsEvents() {
        this.api.on('close', () => this.setStatus('offline'));
        // this.api.on('connect', () => this.setStatus('ok'));
    }

    private freeFsEvents() {
        if (this.api) {
            this.api.off();
        }
    }

    private getNewFS(path: string, skipContext = false): Fs {
        let newfs = getFS(path);

        if (newfs) {
            !skipContext && this.api && this.saveContext();

            // we need to free events in any case
            this.freeFsEvents();
            this.fs = newfs;
            this.api = new newfs.API(path);
            this.bindFsEvents();
        }

        return newfs;
    }

    public getAPI(): FsApi {
        return this.api;
    }

    public getFS(): Fs {
        return this.fs;
    }

    @action
    private updatePath(path: string, skipHistory = false) {
        this.previousPath = this.path;
        this.path = path;

        if (!skipHistory && this.status !== 'login') {
            this.addPathToHistory(path);
        }
    }

    @action
    revertPath() {
        // first revert fs/path
        this.restoreContext();
        // only reload directory if connection hasn't been lost otherwise we enter
        // into an infinite loop
        if (this.api.isConnected()) {
            this.navHistory(0);
            this.status = 'ok';
        }
    }

    @action
    waitForConnection() {
        if (!this.api.isConnected()) {
            this.loginDefer = new Deferred();

            // automatially reconnect if we got credentials
            if (this.api.loginOptions) {
                this.doLogin();
            } else {
                // otherwise show login dialog
                this.status = 'login';
            }

            return this.loginDefer.promise;
        } else {
            this.status = 'busy';
            return Promise.resolve();
        }
    }



    @action
    onLoginSuccess() {
        this.status = 'ok';
        this.loginDefer.resolve();
    }

    @action
    async doLogin(server?: string, credentials?: ICredentials) {
        console.log('logging in');
        // this.status = 'busy';
        if (server) {
            this.server = this.fs.serverpart(server);
        }

        try {
            await this.api.login(server, credentials);
            this.onLoginSuccess();
        } catch (err) {
            this.setErrorString(err);
            this.loginDefer.reject(err);
        }
        // .then(() => ).catch((err) => {
        //     console.log('error while connecting', err);

        // });

        return this.loginDefer.promise;
    }

    @action clearSelection() {
        this.selected.clear();
    }

    reload() {
        this.navHistory(0, true);
    }

    setErrorString(error: any) {
        if (typeof error.code === 'undefined') {
            debugger;
            error.code = 'NOCODE';
        }
        console.log(error.stack);

        switch (error.code) {
            case 'ENOTFOUND':
                debugger;
                error.message = i18next.t('ERRORS.ENOTFOUND');
                break;

            case 'ECONNREFUSED':
                error.message = i18next.t('ERRORS.ECONNREFUSED');
                break;

            case 'ENOENT':
                error.message = i18next.t('ERRORS.ENOENT');
                break;

            case 'EPERM':
                error.message = i18next.t('ERRORS.EPERM');
                break;

            case 'BAD_FILENAME':
                const acceptedChars = isWin ? i18next.t('ERRORS.WIN_VALID_FILENAME') : i18next.t('ERRORS.UNIX_VALID_FILENAME');

                error.message = i18next.t('ERRORS.BAD_FILENAME', { entry: error.newName }) + '. ' + acceptedChars;
                break;

            case 530:
                error.message = i18next.t('ERRORS.530');
                break;

            case 550:
                error.message = i18next.t('ERRORS.550');
                break;

            default:
                debugger;
                error.message = i18next.t('ERRORS.UNKNOWN');
                break;
        }
    }

    handleError = (error: any) => {
        console.log('handleError', error);
        this.status = 'ok';
        this.setErrorString(error);
        return Promise.reject(error);
    }

    @action
    async cd(path: string, path2: string = '', skipHistory = false, skipContext = false): Promise<string> {
        // first updates fs (eg. was local fs, is now ftp)
        console.log('cd', path, this.path);

        if (this.path !== path) {
            if (this.getNewFS(path, skipContext)) {
                this.server = this.fs.serverpart(path);
                this.credentials = this.fs.credentials(path);
            } else {
                this.navHistory(0);
                return Promise.reject({
                    message: i18next.t('ERRORS.CANNOT_READ_FOLDER', { folder: path }),
                    code: 'NO_FS'
                });
            }
        }

        return this.cwd(path, path2, skipHistory, skipContext);
    }

    @action
    @needsConnection
    // changes current path and retrieves file list
    async cwd(path: string, path2: string = '', skipHistory = false, skipContext = false): Promise<string> {
        // try {
        //     await this.waitForConnection();
        // } catch (err) {
        //     return this.cd(path, path2, false, true);
        // }
        const joint = path2 ? this.api.join(path, path2) : this.api.sanityze(path);
        return this.api.cd(joint)
            .then((path) => {
                this.updatePath(path, skipHistory);
                return this.list(path).then(() => path);
            })
            .catch((error) => {
                console.log('path not valid ?', joint, 'restoring previous path');
                this.status = 'ok';
                this.navHistory(0);
                this.setErrorString(error);
                return Promise.reject(error);
            });
    }

    @action
    @needsConnection
    async list(path: string, appendParent?: boolean): Promise<File[]> {
        return this.api.list(path, appendParent)
            .then((files: File[]) => {
                runInAction(() => {
                    console.log('run in actions', this.path);
                    this.files.replace(files);
                    // clear lister selection as well
                    this.clearSelection();
                    // TODO: sync caches ?

                    this.status = 'ok';
                });

                return files;
            })
            .catch(this.handleError)
    }

    @action
    @needsConnection
    async rename(source: string, file: File, newName: string): Promise<string> {
        // // TODO: check for valid filenames
        // try {
        //     await this.waitForConnection();
        // } catch (err) {
        //     return this.rename(source, file, newName);
        // }
        return this.api.rename(source, file, newName).then((newName: string) => {
            runInAction(() => {
                file.fullname = newName;
                this.status = 'ok';
            });

            return newName;
        })
            .catch(this.handleError);
    }

    @action
    @needsConnection
    async exists(path: string): Promise<boolean> {
        // await this.waitForConnection();
        return this.api.exists(path).then((exists) => {
            runInAction(() => {
                this.status = 'ok';
            });
            return exists;
        })
            .catch(this.handleError)
    }

    @action
    @needsConnection
    async makedir(parent: string, dirName: string): Promise<string> {
        return this.api.makedir(parent, dirName).then((newDir) => {
            runInAction(() => {
                this.status = 'ok';
            });

            return newDir;
        })
            .catch(this.handleError)
    }

    @action
    @needsConnection
    async delete(source: string, files: File[]): Promise<number> {
        return this.api.delete(source, files).then((num) => {
            runInAction(() => {
                this.status = 'ok';
            });

            return num;
        })
            .catch(this.handleError)
    }

    @needsConnection
    async size(source: string, files: string[]): Promise<number> {
        // try {
        //     await this.waitForConnection();
        // } catch (err) {
        //     return this.size(source, files);
        // }

        return this.api.size(source, files)
            .catch(this.handleError)
    }

    @needsConnection
    async get(path: string, file: string): Promise<string> {
        // try {
        //     await this.waitForConnection();
        // } catch (err) {
        //     return this.get(path, file);
        // }

        return this.api.get(path, file).then((path) => {
            this.status = 'ok';
            return path;
        })
            .catch(this.handleError)
    }

    async isDir(path: string): Promise<boolean> {
        await this.waitForConnection();
        return this.api.isDir(path);
    }

    isDirectoryNameValid = (dirName: string) => {
        return this.api.isDirectoryNameValid(dirName);
    }

    join(path: string, path2: string) {
        return this.api.join(path, path2);
    }

    openFile(file: File) {
        console.log('need to open file');
        return this.get(file.dir, file.fullname).then((tmpPath: string) => {
            console.log('opening file', tmpPath);
            shell.openItem(tmpPath);
        });
    }

    openDirectory(file: File) {
        console.log('need to read dir', file.dir, file.fullname);
        return this.cd(file.dir, file.fullname).catch(this.handleError);
    }

    openTerminal(path: string) {
        if (this.getFS().name === 'local') {
            ipcRenderer.send('openTerminal', path);
        }
    }

    isRoot(path: string): boolean {
        return this.api.isRoot(path);
    }
}
