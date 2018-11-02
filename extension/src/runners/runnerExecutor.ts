// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as cp from 'child_process';
import { ExtensionContext, window } from 'vscode';
import { testCodeLensProvider } from '../codeLensProvider';
import { CHILD_PROCESS_MAX_BUFFER_SIZE } from '../constants/configs';
import { ITestItem, TestKind } from '../protocols';
import { IExecutionConfig } from '../runConfigs';
import { testResultManager } from '../testResultManager';
import { testStatusBarProvider } from '../testStatusBarProvider';
import { killProcess } from '../utils/cpUtils';
import { ITestRunner } from './ITestRunner';
import { JUnit4Runner } from './junit4Runner/Junit4Runner';
import { JUnit5Runner } from './junit5Runner/JUnit5Runner';
import { ITestResult } from './models';
import { TestNGRunner } from './testngRunner/TestNGRunner';

export class RunnerExecutor {
    private isRunning: boolean;
    private preLaunchTask: cp.ChildProcess | undefined;
    private runnerMap: Map<ITestRunner, ITestItem[]> | undefined;

    constructor(private _javaHome: string, private _context: ExtensionContext) {
    }

    public async run(testItems: ITestItem[], isDebug: boolean = false, config?: IExecutionConfig): Promise<void> {
        if (this.isRunning) {
            window.showInformationMessage('A test session is currently running. Please wait until it finishes.');
            return;
        }
        this.isRunning = true;
        testStatusBarProvider.showRunningTest();
        try {
            this.runnerMap = this.classifyTestsByKind(testItems);
            for (const [runner, tests] of this.runnerMap.entries()) {
                if (config && config.preLaunchTask.length > 0) {
                    this.preLaunchTask = cp.exec(
                        config.preLaunchTask,
                        {
                            maxBuffer: CHILD_PROCESS_MAX_BUFFER_SIZE,
                            cwd: config.workingDirectory,
                        },
                    );
                    await this.execPreLaunchTask();
                }
                await runner.setup(tests, isDebug, config);
                const results: ITestResult[] = await runner.run();
                testResultManager.storeResult(...results);
                testStatusBarProvider.showTestResult(results);
                testCodeLensProvider.refresh();
            }
        } catch (error) {
            window.showErrorMessage(`${error}`);
        } finally {
            await this.cleanUp();
        }
    }

    private async cleanUp(): Promise<void> {
        try {
            if (this.preLaunchTask) {
                await killProcess(this.preLaunchTask);
                this.preLaunchTask = undefined;
            }

            const promises: Array<Promise<void>> = [];
            if (this.runnerMap) {
                for (const runner of this.runnerMap.keys()) {
                    promises.push(runner.cleanUp());
                }
                this.runnerMap.clear();
                this.runnerMap = undefined;
            }
            await Promise.all(promises);
        } catch (error) {
            // Swallow
        }
        this.isRunning = false;
    }

    private classifyTestsByKind(tests: ITestItem[]): Map<ITestRunner, ITestItem[]> {
        const testMap: Map<string, ITestItem[]> = this.mapTestsByProjectAndKind(tests);
        return this.mapTestsByRunner(testMap);
    }

    private mapTestsByProjectAndKind(tests: ITestItem[]): Map<string, ITestItem[]> {
        const map: Map<string, ITestItem[]> = new Map<string, ITestItem[]>();
        for (const test of tests) {
            const key: string = test.project.concat(test.kind.toString());
            const testArray: ITestItem[] | undefined = map.get(key);
            if (testArray) {
                testArray.push(test);
            } else {
                map.set(key, [test]);
            }
        }
        return map;
    }

    private mapTestsByRunner(testsPerProjectAndKind: Map<string, ITestItem[]>): Map<ITestRunner, ITestItem[]> {
        const map: Map<ITestRunner, ITestItem[]> = new Map<ITestRunner, ITestItem[]>();
        for (const tests of testsPerProjectAndKind.values()) {
            const runner: ITestRunner | undefined = this.getRunnerByKind(tests[0].kind);
            if (runner) {
                map.set(runner, tests);
            } else {
                window.showWarningMessage(`Cannot find matched runner to run the test: ${tests[0].kind}`);
            }
        }
        return map;
    }

    private getRunnerByKind(kind: TestKind): ITestRunner | undefined {
        switch (kind) {
            case TestKind.JUnit:
                return new JUnit4Runner(this._javaHome, this._context.storagePath, this._context.extensionPath);
            case TestKind.JUnit5:
                return new JUnit5Runner(this._javaHome, this._context.storagePath, this._context.extensionPath);
            case TestKind.TestNG:
                return new TestNGRunner(this._javaHome, this._context.storagePath, this._context.extensionPath);
            default:
                return undefined;
        }
    }

    private async execPreLaunchTask(): Promise<number> {
        return new Promise<number>((resolve: (ret: number) => void, reject: (err: Error) => void): void => {
            if (this.preLaunchTask) {
                this.preLaunchTask.on('error', (err: Error) => {
                    // TODO: Log
                    reject(err);
                });
                this.preLaunchTask.stderr.on('data', (_data: Buffer) => {
                    // TODO: Log
                });
                this.preLaunchTask.stdout.on('data', (_data: Buffer) => {
                    // TODO: Log
                });
                this.preLaunchTask.on('close', (signal: number) => {
                    if (signal && signal !== 0) {
                        reject(new Error(`Prelaunch task exited with code ${signal}.`));
                    } else {
                        resolve(signal);
                    }
                });
            }
        });
    }
}