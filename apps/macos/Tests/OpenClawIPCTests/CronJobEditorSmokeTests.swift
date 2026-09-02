import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CronJobEditorSmokeTests {
    private func makeEditor(job: CronJob? = nil, channelsStore: ChannelsStore? = nil) -> CronJobEditor {
        CronJobEditor(
            job: job,
            isSaving: .constant(false),
            error: .constant(nil),
            channelsStore: channelsStore ?? ChannelsStore(isPreview: true),
            onCancel: {},
            onSave: { _ in })
    }

    @Test func `cron job editor preserves advanced delivery routes`() {
        let channelsStore = ChannelsStore(isPreview: true)
        let job = CronJob(
            id: "job-1",
            agentId: "ops",
            name: "Daily summary",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
            schedule: .every(everyMs: 3_600_000, anchorMs: 1_700_000_000_000),
            sessionTarget: .isolated,
            wakeMode: .nextHeartbeat,
            payload: .agentTurn(
                message: "Summarize the last day",
                thinking: "low",
                timeoutSeconds: 120,
                deliver: nil,
                channel: nil,
                to: nil,
                bestEffortDeliver: nil),
            delivery: CronDelivery(
                mode: .announce,
                channel: "whatsapp",
                to: "+15551234567",
                bestEffort: true,
                threadId: AnyCodable(42),
                completionDestination: [
                    "mode": AnyCodable("webhook"),
                    "to": AnyCodable("https://example.test/complete"),
                ],
                failureDestination: [
                    "mode": AnyCodable("announce"),
                    "channel": AnyCodable("telegram"),
                    "to": AnyCodable("ops"),
                    "accountId": AnyCodable("alerts"),
                ]),
            state: CronJobState(
                nextRunAtMs: 1_700_000_100_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: "ok",
                lastError: nil,
                lastDurationMs: 1000))

        let view = self.makeEditor(job: job, channelsStore: channelsStore)
        let delivery = view.buildDelivery()
        #expect(delivery["threadId"] as? Int == 42)
        #expect((delivery["completionDestination"] as? [String: Any])?["to"] as? String ==
            "https://example.test/complete")
        #expect((delivery["failureDestination"] as? [String: Any])?["accountId"] as? String == "alerts")
    }

    @Test(arguments: [false, true])
    func `owner switching clears recipients and threads while preserving account constraints`(withAccount: Bool) throws {
        let account = withAccount ? #", "accountId":"alerts""# : ""
        let data = Data("""
        {
          "id":"monitor-1","name":"Monitor","enabled":true,
          "createdAtMs":1,"updatedAtMs":1,
          "schedule":{"kind":"every","everyMs":1800000},
          "sessionTarget":"session:agent:ops:main","wakeMode":"now",
          "payload":{"kind":"agentTurn","message":"Check scratch","skipIfScratchEmpty":true},
          "delivery":{"mode":"announce","channel":"telegram","to":"group-route","threadId":73,
            "directPolicy":"block", "bestEffort":true,
            "failureDestination":{"mode":"announce","channel":"telegram","to":"failure-dm"}\(account)},
          "activeHours":{"start":"22:00","end":"06:00"},"idleOnly":true,
          "state":{}
        }
        """.utf8)
        let job = try JSONDecoder().decode(CronJob.self, from: data)
        let view = CronJobEditor(
            job: job, isSaving: .constant(false), error: .constant(nil),
            channelsStore: ChannelsStore(isPreview: true), onCancel: {}, onSave: { _ in },
            name: "Updated monitor", sessionTarget: .isolated,
            preservedSessionTargetRaw: job.sessionTargetDisplayValue, agentMessage: "Check scratch",
            deliveryTarget: "owner", bestEffortDeliver: true)
        let patch = try view.buildPayload()
        let delivery = try #require(patch["delivery"]?.value as? [String: Any])
        var expected: [String: Any] = [
            "mode": "announce", "target": "owner", "to": NSNull(), "threadId": NSNull(),
            "channel": NSNull(), "directPolicy": "block", "bestEffort": true,
            "failureDestination": ["mode": "announce", "channel": "telegram", "to": "failure-dm"],
        ]
        if withAccount {
            expected["channel"] = "telegram"
            expected["accountId"] = "alerts"
        }
        #expect(NSDictionary(dictionary: delivery).isEqual(to: expected))
        #expect(patch["sessionTarget"]?.value as? String == "session:agent:ops:main")

        let ownerDelivery = delivery.filter { !($0.value is NSNull) }
        var ownerJSON = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        ownerJSON["delivery"] = ownerDelivery
        let owner = try JSONDecoder().decode(CronJob.self, from: JSONSerialization.data(withJSONObject: ownerJSON))
        for channel in ["telegram", "discord"] {
            let reverse = CronJobEditor(
                job: owner, isSaving: .constant(false), error: .constant(nil),
                channelsStore: ChannelsStore(isPreview: true), onCancel: {}, onSave: { _ in },
                name: "Explicit recipient", sessionTarget: .isolated,
                preservedSessionTargetRaw: owner.sessionTargetDisplayValue, agentMessage: "Check scratch",
                deliveryTarget: "", channel: channel, to: "chosen-recipient", bestEffortDeliver: true)
            let reversePatch = try reverse.buildPayload()
            let reversed = try #require(reversePatch["delivery"]?.value as? [String: Any])
            var expectedReverse = ownerDelivery
            expectedReverse["target"] = NSNull()
            expectedReverse["channel"] = channel
            expectedReverse["to"] = "chosen-recipient"
            if withAccount, channel != "telegram" { expectedReverse["accountId"] = NSNull() }
            #expect(NSDictionary(dictionary: reversed).isEqual(to: expectedReverse))
        }
    }

    @Test func `cron job editor includes delete after run for at schedule`() {
        let view = self.makeEditor()

        var root: [String: Any] = [:]
        view.applyDeleteAfterRun(to: &root, scheduleKind: CronJobEditor.ScheduleKind.at, deleteAfterRun: true)
        let raw = root["deleteAfterRun"] as? Bool
        #expect(raw == true)
    }
}
