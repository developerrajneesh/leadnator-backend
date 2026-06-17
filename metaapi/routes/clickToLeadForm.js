const express = require('express');
const router = express.Router();
const ClickToLeadFormService = require('../services/ClickToLeadForm');

// Get pages for current user
router.get('/pages', async (req, res) => {
  try {
    const { fb_token } = req.query;

    if (!fb_token) {
      return res.status(400).json({
        error: 'Missing required query parameter: fb_token is required'
      });
    }

    const pages = await ClickToLeadFormService.getUserPages(fb_token);

    res.status(200).json({
      success: true,
      data: pages
    });
  } catch (error) {
    console.error('Error fetching user pages:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Get lead forms for a page
router.get('/leadforms', async (req, res) => {
  try {
    const { page_id, fb_token } = req.query;

    if (!page_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required query parameters: page_id and fb_token are required'
      });
    }

    const forms = await ClickToLeadFormService.getLeadForms(page_id, fb_token);

    res.status(200).json({
      success: true,
      data: forms
    });
  } catch (error) {
    console.error('Error fetching lead forms:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Create Campaign
router.post('/campaigns', async (req, res) => {
  try {
    const { act_ad_account_id, fb_token, ...campaignData } = req.body;

    if (!act_ad_account_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: act_ad_account_id and fb_token are required in request body'
      });
    }

    const result = await ClickToLeadFormService.createCampaign(
      act_ad_account_id,
      fb_token,
      campaignData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating Lead Form campaign:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Create Lead Form
router.post('/leadforms', async (req, res) => {
  try {
    const { page_id, fb_token, ...formData } = req.body;

    if (!page_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: page_id and fb_token are required in request body'
      });
    }

    const result = await ClickToLeadFormService.createLeadForm(
      page_id,
      fb_token,
      formData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating lead form:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Create Ad Set
router.post('/adsets', async (req, res) => {
  try {
    const { act_ad_account_id, fb_token, ...adsetData } = req.body;

    if (!act_ad_account_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: act_ad_account_id and fb_token are required in request body'
      });
    }

    const result = await ClickToLeadFormService.createAdSet(
      act_ad_account_id,
      fb_token,
      adsetData
    );
console.log(adsetData,'adsetDataadsetData');

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating Lead Form ad set:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Create Ad Creative
router.post('/adcreatives', async (req, res) => {
  try {
    const { act_ad_account_id, fb_token, ...creativeData } = req.body;

    if (!act_ad_account_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: act_ad_account_id and fb_token are required in request body'
      });
    }

    const result = await ClickToLeadFormService.createAdCreative(
      act_ad_account_id,
      fb_token,
      creativeData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating Lead Form ad creative:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Create Ad
router.post('/ads', async (req, res) => {
  try {
    const { act_ad_account_id, fb_token, ...adData } = req.body;

    if (!act_ad_account_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: act_ad_account_id and fb_token are required in request body'
      });
    }

    const result = await ClickToLeadFormService.createAd(
      act_ad_account_id,
      fb_token,
      adData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating Lead Form ad:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Retrieve Leads
router.get('/leads/:leadFormId', async (req, res) => {
  try {
    const { leadFormId } = req.params;
    const { fb_token, page_id } = req.query; // Using query params for GET requests

    if (!fb_token || !page_id) {
      return res.status(400).json({
        error: 'Missing required query parameters: fb_token and page_id are required'
      });
    }

    const leads = await ClickToLeadFormService.retrieveLeads(
      leadFormId,
      fb_token,
      page_id
    );

    res.status(200).json({
      success: true,
      data: leads
    });
  } catch (error) {
    console.error('Error retrieving leads:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Retrieve specific lead by ID
router.get('/leads-by-id/:leadgenId', async (req, res) => {
  try {
    const { leadgenId } = req.params;
    const { fb_token, page_id } = req.query; // Using query params for GET requests

    if (!fb_token || !page_id) {
      return res.status(400).json({
        error: 'Missing required query parameters: fb_token and page_id are required'
      });
    }

    const lead = await ClickToLeadFormService.retrieveLeadById(
      leadgenId,
      fb_token,
      page_id
    );

    res.status(200).json({
      success: true,
      data: lead
    });
  } catch (error) {
    console.error('Error retrieving lead:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Subscribe Page to Webhooks
router.post('/subscribe-page', async (req, res) => {
  try {
    const { page_id, fb_token } = req.body;

    if (!page_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: page_id and fb_token are required in request body'
      });
    }

    const result = await ClickToLeadFormService.subscribePageToWebhooks(
      page_id,
      fb_token
    );

    res.status(200).json({
      success: true,
      message: 'Page subscribed to webhooks successfully',
      data: result
    });
  } catch (error) {
    console.error('Error subscribing page to webhooks:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

module.exports = router;

