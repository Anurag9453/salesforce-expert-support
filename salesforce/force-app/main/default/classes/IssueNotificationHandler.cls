public with sharing class IssueNotificationHandler {
    /**
     * Emails whoever owns the lead when a customer raises a request.
     *
     * Fires on Issue_Information__c rather than Lead, and the reason matters:
     * the platform writes the Lead first and the issue a moment later, so a
     * Lead trigger would send a notification whose whole point — what the
     * customer actually asked for — had not been written yet.
     *
     * Sends to the Lead's owner, which the org's assignment rules have already
     * chosen. That keeps routing in one place instead of hard-coding an address
     * here that has to be maintained separately.
     */
    private static final String TEMPLATE_NAME = 'New Request Notification';

    public static void notifyOwners(List<Issue_Information__c> issues) {
        Set<Id> issueIds = new Set<Id>();
        for (Issue_Information__c issue : issues) {
            if (issue.Lead__c != null) {
                issueIds.add(issue.Id);
            }
        }
        if (issueIds.isEmpty()) {
            return;
        }

        // One query, not one per record: a bulk load of enquiries must not
        // multiply into a query per row.
        Map<Id, Issue_Information__c> loaded = new Map<Id, Issue_Information__c>(
            [SELECT Id, Lead__c, Lead__r.OwnerId, Lead__r.Owner.Email
               FROM Issue_Information__c
              WHERE Id IN :issueIds]
        );

        List<EmailTemplate> templates = [
            SELECT Id FROM EmailTemplate WHERE Name = :TEMPLATE_NAME LIMIT 1
        ];
        if (templates.isEmpty()) {
            return;
        }

        List<Messaging.SingleEmailMessage> messages = new List<Messaging.SingleEmailMessage>();
        for (Issue_Information__c issue : loaded.values()) {
            if (issue.Lead__r == null || issue.Lead__r.OwnerId == null) {
                continue;
            }
            // Queue owners are not users and cannot be a targetObjectId.
            if (String.valueOf(issue.Lead__r.OwnerId).startsWith('00G')) {
                continue;
            }

            Messaging.SingleEmailMessage message = new Messaging.SingleEmailMessage();
            message.setTemplateId(templates[0].Id);
            message.setTargetObjectId(issue.Lead__r.OwnerId);
            message.setWhatId(issue.Id);
            // The notification is a side effect, not a record of anything: saving
            // it as an activity would clutter every lead with noise.
            message.setSaveAsActivity(false);
            messages.add(message);
        }

        if (messages.isEmpty()) {
            return;
        }

        // allOrNone = false: a single bad address must not roll back the issue
        // records that were just written.
        List<Messaging.SendEmailResult> results = Messaging.sendEmail(messages, false);
        for (Messaging.SendEmailResult result : results) {
            if (!result.isSuccess()) {
                System.debug(LoggingLevel.ERROR,
                    'Issue notification failed: ' + result.getErrors()[0].getMessage());
            }
        }
    }
}